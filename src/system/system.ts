import { createActor } from './actor.ts'
import { createEventStream, createRegistry } from './services.ts'
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
  plugins?: PluginDef<any, any>[]
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
  const { shutdownTimeoutMs, plugins: initialPlugins } = options ?? {}
  let shuttingDown = false

  // ─── Shared infrastructure ───
  const metricsRegistry = createMetricsRegistry()
  const services: ActorServices = {
    registry: createRegistry(),
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

  const use = (def: PluginDef<any, any>): Promise<LoadResult> => {
    if (shuttingDown) return Promise.resolve({ ok: false, error: 'system is shutting down' })

    if (plugins.has(def.id)) return Promise.resolve({ ok: false, error: `plugin '${def.id}' already loaded` })

    for (const dep of def.dependencies ?? []) {
      if (plugins.get(dep)?.status !== 'active')
        return Promise.resolve({ ok: false, error: `unsatisfied dependency: '${dep}'` })
    }

    plugins.set(def.id, {
      id: def.id,
      version: def.version,
      dependencies: def.dependencies ?? [],
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
      ctx.spawn(`${def.id}`, wrappedDef, def.initialState)
    })
  }

  const unloadPlugin = async (id: string): Promise<UnloadResult> => {
    const plugin = plugins.get(id)
    if (!plugin) return { ok: false, error: `plugin '${id}' not found` }
    if (plugin.status !== 'active')
      return { ok: false, error: `plugin '${id}' is not active (status: ${plugin.status})` }

    for (const [, p] of plugins) {
      if (p.status === 'active' && p.dependencies.includes(id))
        return { ok: false, error: `plugin '${p.id}' depends on '${id}'` }
    }

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

  // ─── Load initial plugins (serially — respects dependency order) ───
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

  const subscribe = <T>(
    topic: EventTopic<T>,
    callback: (event: T) => void,
  ): (() => void) => {
    services.eventStream.subscribe("system", topic, callback)
    return () => services.eventStream.unsubscribe("system", topic)
  }

  return {
    spawn, stop, shutdown, publish, subscribe,
    use,
    unloadPlugin,
    reloadPlugin,
    hotReloadPlugin,
    listPlugins: () => [...plugins.values()],
    getPluginStatus: (id) => plugins.get(id),
  }
}
