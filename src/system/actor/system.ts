import { createActor } from './actor.ts'
import { createEventStream } from './services.ts'
import { createMetricsRegistry } from './metrics.ts'
import { deepMerge } from './config.ts'
import { OutboundAdminBroadcastTopic } from '../../types/events.ts'
import type { ActorHealth } from '../../types/health.ts'
import {
  LogTopic,
  SystemLifecycleTopic,
  type ActorContext,
  type ActorDef,
  type ActorIdentity,
  type ActorRef,
  type ActorServices,
  type EventTopic,
  type LifecycleEvent,
  type LoadedPlugin,
  type LoadOptions,
  type LoadResult,
  type PluginDef,
  type PluginSystem,
  type UnloadResult,
} from './types.ts'

/** Map direct plugin root actor names (`system/<id>`) to plugin id; ignore deeper paths. */
const directChildPluginId = (actorName: string): string | undefined => {
  const m = /^system\/([^/]+)$/.exec(actorName)
  return m?.[1]
}

export type PluginSystemOptions = {
  /**
   * Maximum time (in ms) to wait for the root actor's drain to complete
   * during `shutdown()`. If the drain hasn't finished by this deadline,
   * the root actor's mailbox is force-closed.
   */
  shutdownTimeoutMs?: number

  /**
   * Plugins to load during system startup, in order.
   * Each plugin is fully activated before the next one is loaded,
   * so dependency ordering is respected.
   * A startup plugin failure never prevents boot: the plugin is marked
   * 'failed', a warning is logged, and startup continues.
   */
  plugins?: (PluginDef<any, any, any> | { def: PluginDef<any, any, any>; modulePath: string })[]

  /**
   * Initial configuration tree. Values are keyed by plugin id (or the plugin's
   * configDescriptor.key) and override plugin defaults. Deep-merged on top of
   * each plugin's configDescriptor.defaults at load time.
   */
  config?: Record<string, unknown>
}

// ─── AgentSystem ──────────────────────────────────────────────────────
//
// Creates the root actor system with integrated plugin management.
//
// The system IS the plugin manager — plugin state lives in this closure
// alongside the actor infrastructure. Plugin root actors are spawned as
// direct children of the root actor at `system/<id>`.
//
// Returns a Promise because initial plugins (from options.plugins) must be
// fully activated before the system is usable.
//
export const AgentSystem = async (
  options?: PluginSystemOptions,
): Promise<PluginSystem> => {
  const { shutdownTimeoutMs, plugins: initialPlugins, config: initialConfig } = options ?? {}
  let shuttingDown = false
  let sub = 0;

  // ─── Global config tree (keyed by plugin id / configDescriptor.key) ───
  const globalConfig: Record<string, unknown> = { ...(initialConfig ?? {}) }

  // ─── Shared infrastructure ───
  const metricsRegistry = createMetricsRegistry()
  const services: ActorServices = {
    eventStream: createEventStream(),
    metricsRegistry,
  }

  // ─── Plugin management state ───
  const plugins = new Map<string, LoadedPlugin>()

  const rootDef: ActorDef<any, null> = {
    initialState: null,

    // No domain message handler — health arrives only via the watch channel
    handler: () => ({ state: null }),

    lifecycle: (state, event) => {
      if (event.type !== 'watchStatus') return { state }

      if (event.status === 'terminated') {
        services.eventStream.publish(SystemLifecycleTopic, event)
        // Clear plugin health when a plugin root dies
        const pluginId = directChildPluginId(event.ref.name)
        if (pluginId && plugins.has(pluginId)) {
          const plugin = plugins.get(pluginId)!
          if (plugin.health !== undefined) {
            const { health: _h, ...rest } = plugin
            plugins.set(pluginId, rest as LoadedPlugin)
          }
        }
        return { state }
      }

      const pluginId = directChildPluginId(event.ref.name)
      const plugin = pluginId ? plugins.get(pluginId) : undefined
      if (plugin) {
        const health: ActorHealth = {
          status: event.status,
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
        }
        plugins.set(pluginId!, { ...plugin, health })
        services.eventStream.publish(OutboundAdminBroadcastTopic, {
          type: 'plugin.health.changed',
          key: pluginId!,
          payload: { id: pluginId!, health },
        })
      }
      return { state }
    },

    ...(shutdownTimeoutMs !== undefined
      ? { shutdown: { drain: true, timeoutMs: shutdownTimeoutMs } }
      : {}),
  }

  const { handle: rootHandle, context: ctx } = createActor('system', rootDef, services)

  const use = (def: PluginDef<any, any, any>, opts?: LoadOptions): Promise<LoadResult> => {
    if (shuttingDown) return Promise.resolve({ ok: false, error: 'system is shutting down' })

    if (plugins.has(def.id)) return Promise.resolve({ ok: false, error: `plugin '${def.id}' already loaded` })

    // ─── Compute config slice for this plugin ───
    const configKey = def.configDescriptor?.key ?? def.id
    const defaults = def.configDescriptor?.defaults
    const userOverride = globalConfig[configKey]
    const configSlice = defaults !== undefined
      ? deepMerge(defaults, userOverride)
      : userOverride
    // Keep global config up to date with merged slice
    if (configSlice !== undefined) globalConfig[configKey] = configSlice

    plugins.set(def.id, {
      id: def.id,
      version: def.version,
      def,
      status: 'loading',
      loadedAt: Date.now(),
      modulePath: opts?.modulePath,
    })

    return new Promise<LoadResult>((resolve) => {
      const orig = def.lifecycle
      const invokeOrig = async (state: any, event: LifecycleEvent, actorCtx: ActorContext<any>) => {
        if (typeof orig === 'function') return orig(state, event, actorCtx)
        if (orig && typeof (orig as any)[event.type] === 'function') {
          return (orig as any)[event.type](state, actorCtx)
        }
        return { state }
      }

      const wrappedDef: ActorDef<any, unknown> = {
        ...def,
        lifecycle: async (state, event, actorCtx) => {
          if (event.type === 'start') {
            try {
              const result = await invokeOrig(state, event, actorCtx)
              const currentPlugin = plugins.get(def.id)!
              // Health arrives via watchStatus after the plugin reports; default ok until then
              const health = currentPlugin.health ?? { status: 'ok' as const }
              plugins.set(def.id, { ...currentPlugin, status: 'active', health })
              resolve({ ok: true, id: def.id })
              return result
            } catch (e) {
              plugins.set(def.id, { ...plugins.get(def.id)!, status: 'failed', error: e })
              resolve({ ok: false, error: String(e) })
              throw e
            }
          }
          return invokeOrig(state, event, actorCtx)
        },
      }
      const ref = ctx.spawn(`${def.id}`, wrappedDef, { config: configSlice })
      // Store ref so updateConfig() can deliver config-change messages
      plugins.set(def.id, { ...plugins.get(def.id)!, ref })
    })
  }

  const updateConfig = (patch: Record<string, unknown>): void => {
    for (const [key, val] of Object.entries(patch)) {
      const prev = globalConfig[key]
      const next = deepMerge(prev, val)
      if (JSON.stringify(prev) === JSON.stringify(next)) continue
      globalConfig[key] = next

      // Notify affected plugins
      for (const plugin of plugins.values()) {
        if (plugin.status !== 'active' || !plugin.ref) continue
        const pluginKey = plugin.def.configDescriptor?.key ?? plugin.def.id
        if (pluginKey !== key) continue
        const onConfigChange = plugin.def.configDescriptor?.onConfigChange
        if (onConfigChange) {
          plugin.ref.send(onConfigChange(next))
        }
      }
    }
  }

  const getConfigSlice = (pluginId?: string): unknown => {
    const slice = pluginId === undefined ? globalConfig : globalConfig[pluginId]
    if (slice === undefined) return {}
    return structuredClone(slice)
  }

  const pendingUnloads = new Map<string, Promise<UnloadResult>>()

  const unloadPlugin = async (id: string): Promise<UnloadResult> => {
    const existing = pendingUnloads.get(id)
    if (existing) return existing

    const plugin = plugins.get(id)
    if (!plugin) return { ok: false, error: `plugin '${id}' not found` }

    const rootName = `system/${id}`

    if (plugin.status !== 'active' && plugin.status !== 'failed' && plugin.status !== 'deactivating') {
      return { ok: false, error: `plugin '${id}' is not active (status: ${plugin.status})` }
    }

    // Fast path for failed plugins: their actor already ran its shutdown
    // sequence when start() threw (watchStatus terminated fired then), so
    // waiting for a fresh terminated after stop() would hang forever.
    if (plugin.status === 'failed') {
      ctx.stop({ name: rootName })
      plugins.delete(id)
      return { ok: true }
    }

    const promise = new Promise<UnloadResult>((resolve) => {
      const watcherName = `$unload-${id}`
      services.eventStream.subscribe(watcherName, SystemLifecycleTopic, (event) => {
        if (
          event.type === 'watchStatus' &&
          event.status === 'terminated' &&
          event.ref.name === rootName
        ) {
          services.eventStream.unsubscribe(watcherName, SystemLifecycleTopic)
          plugins.delete(id)
          pendingUnloads.delete(id)
          resolve({ ok: true })
        }
      })
      plugins.set(id, { ...plugin, status: 'deactivating' })
      ctx.stop({ name: rootName })
    })

    pendingUnloads.set(id, promise)
    return promise
  }

  const reloadPlugin = async (id: string): Promise<LoadResult> => {
    const plugin = plugins.get(id)
    if (!plugin) return { ok: false, error: `plugin '${id}' not found` }
    const modulePath = plugin.modulePath
    const result = await unloadPlugin(id)
    if (!result.ok) return result
    return use(plugin.def, { modulePath })
  }

  const hotReloadPlugin = async (id: string): Promise<LoadResult> => {
    const oldPlugin = plugins.get(id)
    if (!oldPlugin) return { ok: false, error: `plugin '${id}' not found` }
    const modulePath = oldPlugin.modulePath
    if (!modulePath) return { ok: false, error: `modulePath for plugin '${id}' not found` }

    const result = await unloadPlugin(id)
    if (!result.ok) return result
    const { default: imported } = await import(`${modulePath}?t=${Date.now()}`)
    
    let def = imported
    if (typeof imported === 'function') {
      const configKey = oldPlugin?.def.configDescriptor?.key ?? id
      const configSlice = globalConfig[configKey]
      def = imported(configSlice)
    }
    return use(def, { modulePath })
  }

  // ─── Load initial plugins ───
  // A failed plugin never prevents boot: it stays in the registry with
  // status 'failed' (visible via listPlugins()/getPluginStatus()), a warning
  // is logged to the console and the event stream, and startup continues.
  for (const item of initialPlugins ?? []) {
    const def = 'def' in item ? item.def : item
    const modulePath = 'modulePath' in item ? item.modulePath : undefined
    const result = await use(def, { modulePath })
    if (!result.ok) {
      const message = `Startup plugin '${def.id}' failed: ${result.error}`
      console.warn(`[system] ${message}`)
      services.eventStream.publish(LogTopic, {
        level: 'warn',
        source: 'system',
        message,
        timestamp: Date.now(),
        data: { pluginId: def.id, error: result.error },
      })
    }
  }

  // ─── Public facade ───

  const spawn = <M, S>(name: string, def: ActorDef<M, S>, options?: { state?: S }): ActorRef<M> => {
    if (shuttingDown) throw new Error('Cannot spawn actors: system is shutting down')
    return ctx.spawn(name, def, options)
  }

  const stop = (child: ActorIdentity): void => {
    ctx.stop(child)
  }

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    await rootHandle.stop()
  }

  const publish = <T>(topic: EventTopic<T>, event: T): void => {
    services.eventStream.publish(topic, event)
  }

  const publishRetained = <T>(topic: EventTopic<T>, key: string, event: T): void => {
    services.eventStream.publishRetained(topic, key, event)
  }

  const deleteRetained = <T>(topic: EventTopic<T>, key: string, tombstone: T): void => {
    services.eventStream.deleteRetained(topic, key, tombstone)
  }

  const subscribe = <T>(
    topic: EventTopic<T>,
    callback: (event: T) => void,
  ): (() => void) => {
    const subscriberName = `system-${sub++}`
    services.eventStream.subscribe(subscriberName, topic, callback)
    return () => services.eventStream.unsubscribe(subscriberName, topic)
  }

  return {
    spawn, stop, shutdown, publish, publishRetained, deleteRetained, subscribe,
    updateConfig,
    getConfigSlice,
    use,
    unloadPlugin,
    reloadPlugin,
    hotReloadPlugin,
    listPlugins: () => [...plugins.values()],
    getPluginStatus: (id) => plugins.get(id),
  }
}
