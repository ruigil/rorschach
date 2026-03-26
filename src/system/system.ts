import { createActor } from './actor.ts'
import { createEventStream } from './services.ts'
import { createMetricsRegistry } from './metrics.ts'
import {
  SystemLifecycleTopic,
  type ActorDef,
  type ActorIdentity,
  type ActorRef,
  type ActorServices,
  type EventTopic,
  type LoadedPlugin,
  type LoadResult,
  type PluginDef,
  type PluginSystem,
  type UnloadResult,
} from './types.ts'

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
   * A startup plugin failure throws and prevents the system from being returned.
   */
  plugins?: PluginDef<any, any, any>[]

  /**
   * Initial configuration tree. Values are keyed by plugin id (or the plugin's
   * configDescriptor.key) and override plugin defaults. Deep-merged on top of
   * each plugin's configDescriptor.defaults at load time.
   */
  config?: Record<string, unknown>
}

// ─── Deep merge utility ──────────────────────────────────────────────────────
//
// Recursively merges `override` on top of `base`. Only plain objects are merged
// deeply — arrays, primitives, and class instances are replaced wholesale.
//
const deepMerge = (base: unknown, override: unknown): unknown => {
  if (
    override === null ||
    typeof override !== 'object' ||
    Array.isArray(override)
  ) {
    return override ?? base
  }
  if (base === null || typeof base !== 'object' || Array.isArray(base)) {
    return override
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, val] of Object.entries(override as Record<string, unknown>)) {
    if (val !== undefined) {
      result[key] = deepMerge(result[key], val)
    }
  }
  return result
}

// ─── createPluginSystem ──────────────────────────────────────────────────────
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
export const createPluginSystem = async (
  options?: PluginSystemOptions,
): Promise<PluginSystem> => {
  const { shutdownTimeoutMs, plugins: initialPlugins, config: initialConfig } = options ?? {}
  let shuttingDown = false

  // ─── Global config tree (keyed by plugin id / configDescriptor.key) ───
  const globalConfig: Record<string, unknown> = { ...(initialConfig ?? {}) }

  // ─── Shared infrastructure ───
  const metricsRegistry = createMetricsRegistry()
  const services: ActorServices = {
    eventStream: createEventStream(),
    metricsRegistry,
  }

  const rootDef: ActorDef<never, null> = {
    handler: (state) => ({ state }),

    lifecycle: (state, event) => {
      if (event.type === 'terminated') {
        services.eventStream.publish(SystemLifecycleTopic, event)
      }
      return { state }
    },

    ...(shutdownTimeoutMs !== undefined
      ? { shutdown: { drain: true, timeoutMs: shutdownTimeoutMs } }
      : {}),
  }

  const { handle: rootHandle, context: ctx } = createActor('system', rootDef, null, services)

  // ─── Plugin management state ───
  const plugins = new Map<string, LoadedPlugin>()

  const use = (def: PluginDef<any, any, any>): Promise<LoadResult> => {
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
    })

    return new Promise<LoadResult>((resolve) => {
      const orig = def.lifecycle
      const wrappedDef: ActorDef<any, unknown> = {
        ...def,
        lifecycle: async (state, event, actorCtx) => {
          if (event.type === 'start') {
            try {
              const result = await orig?.(state, event, actorCtx) ?? { state }
              plugins.set(def.id, { ...plugins.get(def.id)!, status: 'active' })
              resolve({ ok: true, id: def.id })
              return result
            } catch (e) {
              plugins.set(def.id, { ...plugins.get(def.id)!, status: 'failed', error: e })
              resolve({ ok: false, error: String(e) })
              throw e
            }
          }
          return orig?.(state, event, actorCtx) ?? { state }
        },
      }
      const ref = ctx.spawn(`${def.id}`, wrappedDef, def.initialState, { config: configSlice })
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

  const unloadPlugin = async (id: string): Promise<UnloadResult> => {
    const plugin = plugins.get(id)
    if (!plugin) return { ok: false, error: `plugin '${id}' not found` }
    if (plugin.status !== 'active')
      return { ok: false, error: `plugin '${id}' is not active (status: ${plugin.status})` }

    return new Promise<UnloadResult>((resolve) => {
      const rootName = `system/${id}`
      const watcherName = `$unload-${id}`
      services.eventStream.subscribe(watcherName, SystemLifecycleTopic, (event) => {
        if (event.type === 'terminated' && event.ref.name === rootName) {
          services.eventStream.unsubscribe(watcherName, SystemLifecycleTopic)
          plugins.delete(id)
          resolve({ ok: true })
        }
      })
      plugins.set(id, { ...plugin, status: 'deactivating' })
      ctx.stop({ name: rootName })
    })
  }

  const reloadPlugin = async (id: string): Promise<LoadResult> => {
    const plugin = plugins.get(id)
    if (!plugin) return { ok: false, error: `plugin '${id}' not found` }
    const result = await unloadPlugin(id)
    if (!result.ok) return result
    return use(plugin.def)
  }

  const hotReloadPlugin = async (id: string, path: string): Promise<LoadResult> => {
    const result = await unloadPlugin(id)
    if (!result.ok) return result
    const { default: def } = await import(`${path}?t=${Date.now()}`)
    return use(def)
  }

  // ─── Load initial plugins ───
  for (const def of initialPlugins ?? []) {
    const result = await use(def)
    if (!result.ok) throw new Error(`Startup plugin '${def.id}' failed: ${result.error}`)
  }

  // ─── Public facade ───

  const spawn = <M, S>(name: string, def: ActorDef<M, S>, initialState: S): ActorRef<M> => {
    if (shuttingDown) throw new Error('Cannot spawn actors: system is shutting down')
    return ctx.spawn(name, def, initialState)
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

  const subscribe = <T>(
    topic: EventTopic<T>,
    callback: (event: T) => void,
  ): (() => void) => {
    services.eventStream.subscribe("system", topic, callback)
    return () => services.eventStream.unsubscribe("system", topic)
  }

  return {
    spawn, stop, shutdown, publish, publishRetained, subscribe,
    updateConfig,
    use,
    unloadPlugin,
    reloadPlugin,
    hotReloadPlugin,
    listPlugins: () => [...plugins.values()],
    getPluginStatus: (id) => plugins.get(id),
  }
}
