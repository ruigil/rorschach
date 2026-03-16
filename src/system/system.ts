import { createActor } from './actor.ts'
import { createEventStream, createRegistry } from './services.ts'
import { createMetricsRegistry } from './metrics.ts'
import { loadPluginModule } from './loader.ts'
import {
  MetricsTopic,
  SystemLifecycleTopic,
  createTopic,
  emit,
  type ActorContext,
  type ActorDef,
  type ActorIdentity,
  type ActorRef,
  type ActorServices,
  type ActorSnapshot,
  type ActorTreeNode,
  type EventTopic,
  type MetricsEvent,
  type ActivationResult,
  type LoadedPlugin,
  type LoadResult,
  type PluginDef,
  type PluginHandle,
  type PluginSource,
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
   * Enable push-based metrics publishing to `MetricsTopic`.
   * When configured, an internal `system/$metrics` actor periodically
   * snapshots all actor metrics and publishes a `MetricsEvent` to the
   * event stream. Omit to disable (zero overhead when not used).
   */
  metrics?: {
    /** Interval (in ms) between metric snapshot publications. */
    intervalMs: number
  }

  /**
   * Plugins to load during system startup, in order.
   * Each plugin is fully activated before the next one is loaded,
   * so dependency ordering is respected.
   * A startup plugin failure throws and prevents the system from being returned.
   */
  plugins?: Array<{ source: PluginSource; config?: unknown }>
}

// ─── Plugin root actor ───────────────────────────────────────────────────────
//
// One plugin root actor per loaded plugin, spawned as a direct child of the
// system root at `system/$plugin-<id>`. Its only responsibilities are:
//   1. Call def.activate() on start via pipeToSelf (handles async activation)
//   2. Publish the ActivationResult to a one-shot topic so the closure resolves
//   3. Call handle.deactivate() in the stopped lifecycle
//
// All actors the plugin spawns become children of this root, so stopping it
// cascades to the entire plugin subtree automatically.
//
type PluginRootMsg =
  | { type: '_activated'; handle: PluginHandle }
  | { type: '_activationFailed'; error: unknown }

type PluginRootState = { handle?: PluginHandle }

const makePluginRootDef = (
  def: PluginDef<unknown>,
  config: unknown,
  activationTopic: EventTopic<ActivationResult>,
): ActorDef<PluginRootMsg, PluginRootState> => ({
  handler: (state, msg) => {
    if (msg.type === '_activated')
      return {
        state: { handle: msg.handle },
        events: [emit(activationTopic, { ok: true, handle: msg.handle })],
      }
    return { state, events: [emit(activationTopic, { ok: false, error: msg.error })] }
  },

  async lifecycle(state, event, actorCtx) {
    if (event.type === 'start') {
      actorCtx.pipeToSelf(
        Promise.resolve(def.activate(actorCtx as unknown as ActorContext<never>, config)),
        (handle) => ({ type: '_activated', handle }),
        (error) => ({ type: '_activationFailed', error }),
      )
    }
    if (event.type === 'stopped') {
      await state.handle?.deactivate?.()
    }
    return { state }
  },
})

// ─── createPluginSystem ──────────────────────────────────────────────────────
//
// Creates the root actor system with integrated plugin management.
//
// The system IS the plugin manager — plugin state lives in this closure
// alongside the actor infrastructure. Plugin root actors are spawned as
// direct children of the root actor at `system/$plugin-<id>`.
//
// Returns a Promise because initial plugins (from options.plugins) must be
// fully activated before the system is usable.
//
export const createPluginSystem = async (
  options?: PluginSystemOptions,
): Promise<PluginSystem> => {
  const { shutdownTimeoutMs, metrics: metricsConfig, plugins: initialPlugins } = options ?? {}
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

  // ─── Internal metrics actor ───
  if (metricsConfig) {
    type MetricsMsg = { type: 'tick' }

    const metricsActorDef: ActorDef<MetricsMsg, null> = {
      lifecycle: (s, event, metCtx) => {
        if (event.type === 'start') {
          metCtx.timers.startPeriodicTimer('metrics-tick', { type: 'tick' }, metricsConfig.intervalMs)
        }
        return { state: s }
      },
      handler: (s, _msg, metCtx) => {
        const event: MetricsEvent = {
          timestamp: Date.now(),
          actors: metricsRegistry.snapshotAll(),
        }
        metCtx.publish(MetricsTopic, event)
        return { state: s }
      },
    }

    ctx.spawn('$metrics', metricsActorDef, null)
  }

  // ─── Plugin management state ───
  const plugins = new Map<string, LoadedPlugin>()

  const loadPlugin = async (source: PluginSource, config?: unknown): Promise<LoadResult> => {
    if (shuttingDown) return { ok: false, error: 'system is shutting down' }

    let def: PluginDef<unknown>
    try {
      def = await loadPluginModule(source)
    } catch (e) {
      return { ok: false, error: String(e) }
    }

    if (plugins.has(def.id)) return { ok: false, error: `plugin '${def.id}' already loaded` }

    for (const dep of def.dependencies ?? []) {
      if (plugins.get(dep)?.status !== 'active')
        return { ok: false, error: `unsatisfied dependency: '${dep}'` }
    }

    plugins.set(def.id, {
      id: def.id,
      version: def.version,
      dependencies: def.dependencies ?? [],
      source,
      config,
      status: 'loading',
      loadedAt: Date.now(),
    })

    const activationTopic = createTopic<ActivationResult>(`$plugin:activation:${def.id}`)
    const subName = `$plugin-load:${def.id}`

    return new Promise<LoadResult>((resolve) => {
      services.eventStream.subscribe(subName, activationTopic, (result) => {
        services.eventStream.unsubscribe(subName, activationTopic)
        services.eventStream.deleteTopic(activationTopic)
        if (result.ok) {
          plugins.set(def.id, { ...plugins.get(def.id)!, status: 'active', handle: result.handle })
          resolve({ ok: true, id: def.id })
        } else {
          plugins.set(def.id, { ...plugins.get(def.id)!, status: 'failed', error: result.error })
          resolve({ ok: false, error: String(result.error) })
        }
      })
      ctx.spawn(`$plugin-${def.id}`, makePluginRootDef(def, config, activationTopic), {})
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

    plugins.set(id, { ...plugin, status: 'deactivating' })

    const subName = `$plugin-unload:${id}`
    return new Promise<UnloadResult>((resolve) => {
      services.eventStream.subscribe(subName, SystemLifecycleTopic, (event) => {
        if (event.type === 'terminated' && event.ref.name === `system/$plugin-${id}`) {
          services.eventStream.unsubscribe(subName, SystemLifecycleTopic)
          plugins.delete(id)
          resolve({ ok: true })
        }
      })
      ctx.stop({ name: `system/$plugin-${id}` })
    })
  }

  const reloadPlugin = async (id: string): Promise<LoadResult> => {
    const plugin = plugins.get(id)
    if (!plugin) return { ok: false, error: `plugin '${id}' not found` }
    const { source, config } = plugin
    const result = await unloadPlugin(id)
    if (!result.ok) return result
    return loadPlugin(source, config)
  }

  // ─── Load initial plugins (serially — respects dependency order) ───
  for (const { source, config } of initialPlugins ?? []) {
    const result = await loadPlugin(source, config)
    if (!result.ok) {
      const label = source.type === 'path' ? source.value : source.def.id
      throw new Error(`Startup plugin '${label}' failed: ${result.error}`)
    }
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
    subscriberName: string,
    topic: EventTopic<T>,
    callback: (event: T) => void,
  ): (() => void) => {
    services.eventStream.subscribe(subscriberName, topic, callback)
    return () => services.eventStream.unsubscribe(subscriberName, topic)
  }

  const getActorMetrics = (name: string): ActorSnapshot | undefined =>
    metricsRegistry.snapshot(name)

  const getAllActorMetrics = (): ActorSnapshot[] =>
    metricsRegistry.snapshotAll()

  const getActorTree = (): ActorTreeNode[] =>
    metricsRegistry.actorTree()

  return {
    spawn, stop, shutdown, publish, subscribe,
    getActorMetrics, getAllActorMetrics, getActorTree,
    loadPlugin,
    unloadPlugin,
    reloadPlugin,
    listPlugins: () => Promise.resolve([...plugins.values()]),
    getPluginStatus: (id) => Promise.resolve(plugins.get(id)),
    use: (def, config) => loadPlugin({ type: 'inline', def }, config),
  }
}
