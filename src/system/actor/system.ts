import { createActor } from './actor.ts'
import { createEventStream } from './services.ts'
import { ResolutionCache } from '../scr/cache.ts'
import { createMetricsRegistry } from './metrics.ts'
import { deepMerge } from './config.ts'
import { OutboundAdminBroadcastTopic } from '../../types/events.ts'
import { ToolRegistrationTopic } from '../../types/tools.ts'
import { AgentRegistrationTopic } from '../../types/agents.ts'
import { SCRRegistrationTopic } from '../../types/scr.ts'
import type { ActorHealth } from '../../types/health.ts'
import type { ConfigSource, PluginEntry } from '../node/types.ts'
import { createNodeControlDef } from '../node/control.ts'
import { interpolate } from '../node/utils.ts'
import {
  SystemLifecycleTopic,
  type ActorContext,
  type ActorDef,
  type ActorIdentity,
  type ActorRef,
  type ActorServices,
  type ActualSnapshot,
  type EventTopic,
  type LifecycleEvent,
  type LoadedPlugin,
  type OpResult,
  type PluginSystem,
  type SystemControl,
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
   * Desired-state store. When provided, the kernel spawns the node-control
   * actor (system/node-control) and awaits its first converge pass.
   * First-pass source.read failures are soft-fail (constructor still resolves;
   * control retries with backoff). Plugin load failures mark `'failed'` and continue.
   * Omit for a bare kernel (no plugins).
   */
  source?: ConfigSource

  /**
   * Identity key for retained observed state (default `'local'`).
   */
  systemId?: string
}


// ─── AgentSystem ──────────────────────────────────────────────────────
//
// Creates the root actor system with integrated plugin management.
//
// Boot is the first node-control convergence when `source` is set.
// Bare kernel when source is omitted.
//
export const AgentSystem = async (options?: PluginSystemOptions ): Promise<PluginSystem> => {
  const {
    shutdownTimeoutMs,
    source,
    systemId = 'local',
  } = options ?? {}
  let shuttingDown = false
  let sub = 0

  // ─── Global config tree (keyed by plugin id / configDescriptor.key) ───
  const globalConfig: Record<string, unknown> = {}

  // ─── Shared infrastructure ───
  const metricsRegistry = createMetricsRegistry()
  const services: ActorServices = {
    eventStream: createEventStream(),
    metricsRegistry,
  }

  ResolutionCache.clear()
  ResolutionCache.initialize({
    subscribe: <T>(topic: any, callback: (event: T) => void) => {
      const subscriberName = `system-cache-${sub++}`
      services.eventStream.subscribe(subscriberName, topic, callback)
      return () => services.eventStream.unsubscribe(subscriberName, topic)
    }
  })

  // ⚠️ DEPRECATED compatibility bridge: maps SCR registration events back to
  // legacy Tool/Agent topics to support transition phases.
  // TODO: Decommission this entire block and associated topics in Phase 5.
  const bridgeSubId = 'system-legacy-bridge'
  services.eventStream.subscribe(bridgeSubId, SCRRegistrationTopic, (event: any) => {
    if (event.type === 'register') {
      if (event.descriptor.kind === 'leaf') {
        const normalizedToolName = event.descriptor.urn.replace('scr:leaf:', '').replace(/\./g, '_')
        if (event.descriptor.meta?.schema) {
          services.eventStream.publishRetained(ToolRegistrationTopic, normalizedToolName, {
            name: normalizedToolName,
            schema: event.descriptor.meta.schema,
            ref: event.descriptor.target,
            mayBeLongRunning: event.descriptor.yieldsPending || false,
          })
        }
      } else if (event.descriptor.kind === 'reasoner') {
        if (event.descriptor.meta?.agentDescriptor) {
          services.eventStream.publishRetained(AgentRegistrationTopic, event.descriptor.meta.agentDescriptor.mode, {
            type: 'register',
            descriptor: event.descriptor.meta.agentDescriptor,
          })
        }
      }
    } else {
      if (event.urn.startsWith('scr:leaf:')) {
        const normalizedToolName = event.urn.replace('scr:leaf:', '').replace(/\./g, '_')
        services.eventStream.deleteRetained(ToolRegistrationTopic, normalizedToolName, {
          name: normalizedToolName,
          ref: null,
        })
      } else if (event.urn.startsWith('scr:reasoner:')) {
        const mode = event.urn.replace(/^scr:reasoner:[^.]+\./, '')
        services.eventStream.deleteRetained(AgentRegistrationTopic, mode, {
          type: 'unregister',
          mode,
        })
      }
    }
  })

  // ─── Plugin management state ───
  const plugins = new Map<string, LoadedPlugin>()

  const rootDef: ActorDef<any, null> = {
    initialState: null,

    // No domain message handler — health arrives only via the watch channel
    handler: () => ({ state: null }),

    lifecycle: (state, event) => {
      if (event.type !== 'watchStatus') return { state }

      const pluginId = directChildPluginId(event.ref.name)
      if (event.status === 'terminated') {
        services.eventStream.publish(SystemLifecycleTopic, event)
        // Clear plugin health when a plugin root dies
        if (pluginId && plugins.has(pluginId)) {
          const plugin = plugins.get(pluginId)!
          if (plugin.health !== undefined) {
            const { health: _h, ...rest } = plugin
            plugins.set(pluginId, rest as LoadedPlugin)
          }
        }
        return { state }
      }

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

  const pendingUnloads = new Map<string, Promise<OpResult>>()

  const unloadPlugin = async (id: string): Promise<OpResult> => {
    if (!plugins.has(id)) return { ok: true }

    const existing = pendingUnloads.get(id)
    if (existing) return existing

    const plugin = plugins.get(id)!

    const rootName = `system/${id}`

    if (plugin.status !== 'active' && plugin.status !== 'failed' && plugin.status !== 'deactivating') {
      return { ok: false, error: `plugin '${id}' is not active (status: ${plugin.status})` }
    }
    if (plugin.status === 'failed') {
      ctx.stop({ name: rootName })
      plugins.delete(id)
      return { ok: true }
    }

    const promise = new Promise<OpResult>((resolve) => {
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

  // ─── SystemControl ───
  const snapshotActual = (): ActualSnapshot => ({
    plugins: [...plugins.values()].map((p) => ({
      id: p.id,
      version: p.version,
      status: p.status,
      modulePath: p.modulePath,
      error: p.error,
      health: p.health,
      reloadNonce: p.reloadNonce,
    })),
    config: structuredClone(globalConfig),
  })

  const loadPlugin = async (entry: PluginEntry): Promise<OpResult> => {
    if (shuttingDown) return { ok: false, error: 'system is shutting down' }

    try {
      let def = entry.def
      let resolved = entry.modulePath

      if (!def && resolved) {
        const importUrl =
          entry.reloadNonce !== undefined ? `${resolved}?reload=${entry.reloadNonce}` : resolved
        const { default: imported } = await import(importUrl)
        def = typeof imported === 'function' ? imported() : imported
      }

      if (!def || typeof def !== 'object' || typeof def.id !== 'string') {
        return {
          ok: false,
          error: resolved
            ? `Plugin at ${resolved} must export a PluginDef with an "id" field as default`
            : 'Invalid plugin definition',
        }
      }

      const existing = plugins.get(def.id)
      const reloadNonce = entry.reloadNonce
      if (existing?.status === 'active') {
        const curPath = existing.modulePath
        if (
          resolved !== undefined &&
          curPath !== undefined &&
          resolved !== curPath
        ) {
          return {
            ok: false,
            error:
              `plugin '${def.id}' is active at ${curPath ?? '(unknown)'}; ` +
              `converge must Unload first before loading ${resolved}`,
            id: def.id,
          }
        }
        // Equivalent present: save reloadNonce directly.
        plugins.set(def.id, { ...existing, reloadNonce })
        return { ok: true, id: def.id }
      }

      if (existing?.status === 'failed') {
        // Failed repair: unload then load (effector local, not identity-change sequencing).
        await unloadPlugin(def.id)
      }

      if (plugins.has(def.id)) {
        return { ok: false, error: `plugin '${def.id}' already loaded` }
      }

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
        modulePath: resolved,
        reloadNonce,
      })

      return new Promise<OpResult>((resolve) => {
        const orig = def!.lifecycle
        const invokeOrig = async (state: any, event: LifecycleEvent, actorCtx: ActorContext<any>) => {
          if (typeof orig === 'function') return orig(state, event, actorCtx)
          if (orig && typeof (orig as any)[event.type] === 'function') {
            return (orig as any)[event.type](state, actorCtx)
          }
          return { state }
        }

        const wrappedDef: ActorDef<any, unknown> = {
          ...def!,
          lifecycle: async (state, event, actorCtx) => {
            if (event.type === 'start') {
              try {
                const result = await invokeOrig(state, event, actorCtx)
                const currentPlugin = plugins.get(def!.id)!
                // Health arrives via watchStatus after the plugin reports; default ok until then
                const health = currentPlugin.health ?? { status: 'ok' as const }
                plugins.set(def!.id, { ...currentPlugin, status: 'active', health })
                resolve({ ok: true, id: def!.id })
                return result
              } catch (e) {
                plugins.set(def!.id, { ...plugins.get(def!.id)!, status: 'failed', error: e })
                resolve({ ok: false, error: String(e), id: plugins.has(def!.id) ? def!.id : undefined })
                throw e
              }
            }
            return invokeOrig(state, event, actorCtx)
          },
        }
        const ref = ctx.spawn(`${def!.id}`, wrappedDef, { config: configSlice })
        // Store ref so applyConfig can deliver config-change messages
        plugins.set(def!.id, { ...plugins.get(def!.id)!, ref })
      })
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }

  /**
   * Apply a target config tree: replace the live tree with the
   * interpolated desired document. Keys absent from `tree` are deleted.
   * Per-slice values replace (not deep-merge) so nested omissions are deletions.
   */
  const applyConfig = async (tree: Record<string, unknown>): Promise<OpResult> => {
    try {
      const nextTree: Record<string, unknown> = {}
      for (const [key, val] of Object.entries(tree)) {
        nextTree[key] = interpolate(val)
      }

      const keys = new Set([...Object.keys(globalConfig), ...Object.keys(nextTree)])
      for (const key of keys) {
        const hasNext = Object.prototype.hasOwnProperty.call(nextTree, key)
        const next = hasNext ? nextTree[key] : undefined
        const prev = globalConfig[key]
        if (JSON.stringify(prev) === JSON.stringify(next)) continue

        if (hasNext) globalConfig[key] = next
        else delete globalConfig[key]

        for (const plugin of plugins.values()) {
          if (plugin.status !== 'active' || !plugin.ref) continue
          const pluginKey = plugin.def.configDescriptor?.key ?? plugin.def.id
          if (pluginKey !== key) continue
          const onConfigChange = plugin.def.configDescriptor?.onConfigChange
          if (onConfigChange) {
            plugin.ref.send(onConfigChange((hasNext ? next : {}) as never))
          }
        }
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }

  const systemControl: SystemControl = {
    snapshotActual,
    loadPlugin,
    unloadPlugin,
    applyConfig,
  }

  // ─── Node control: first converge is boot ───
  if (source) {
    await new Promise<void>((resolve) => {
      ctx.spawn(
        'node-control',
        createNodeControlDef({
          control: systemControl,
          source,
          systemId,
          onFirstConvergeDone: resolve,
        }),
      )
    })
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
    services.eventStream.unsubscribe(bridgeSubId, SCRRegistrationTopic)
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
    control: () => systemControl,
    spawn,
    stop,
    shutdown,
    publish,
    publishRetained,
    deleteRetained,
    subscribe,
  }

}
