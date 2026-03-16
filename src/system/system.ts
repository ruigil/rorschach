import { createActor } from './actor.ts'
import { createEventStream, createRegistry } from './services.ts'
import { createMetricsRegistry } from './metrics.ts'
import {
  MetricsTopic,
  SystemLifecycleTopic,
  type ActorDef,
  type ActorIdentity,
  type ActorRef,
  type ActorServices,
  type ActorSnapshot,
  type ActorSystem,
  type ActorTreeNode,
  type EventTopic,
  type MetricsEvent,
} from './types.ts'

/**
 * Options for creating an actor system.
 */
export type ActorSystemOptions = {
  /**
   * Maximum time (in ms) to wait for the root actor's drain to complete
   * during `shutdown()`. If the drain hasn't finished by this deadline,
   * the root actor's mailbox is force-closed.
   * Only meaningful when the root actor uses drain-based shutdown (default).
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
}

/**
 * Creates the root actor system.
 *
 * The system IS the root actor — a regular actor named 'system' created via
 * `createActor`. Every actor in the hierarchy, including the root, is managed
 * by the same code path. Children of the root receive 'system/'-prefixed
 * names, exactly like children of any other actor — full naming symmetry.
 *
 * The `ActorSystem` facade delegates structural operations (`spawn`, `stop`)
 * to the root actor's context, captured synchronously during setup.
 * Lifecycle events from children flow through the root actor's mailbox
 * like any other actor.
 *
 * Top-level actor terminations are published to `SystemLifecycleTopic`
 * ('system.lifecycle'). External code can observe them via
 * `system.subscribe(name, SystemLifecycleTopic, callback)`.
 *
 * `publish` and `subscribe` are convenience pass-throughs to the shared
 * event stream infrastructure — they are not root actor capabilities.
 */
export const createActorSystem = (
  options?: ActorSystemOptions,
): ActorSystem => {
  const { shutdownTimeoutMs, metrics: metricsConfig } = options ?? {}
  let shuttingDown = false

  // Shared infrastructure
  const metricsRegistry = createMetricsRegistry()
  const services: ActorServices = {
    registry: createRegistry(),
    eventStream: createEventStream(),
    metricsRegistry,
  }

  const rootDef: ActorDef<never, null> = {
    handler: (state) => ({ state }),

    lifecycle: (state, event) => {
      // Publish child terminated events to the well-known lifecycle topic.
      // External observers subscribe via system.subscribe(name, SystemLifecycleTopic, cb).
      if (event.type === 'terminated') {
        services.eventStream.publish(SystemLifecycleTopic, event)
      }
      return { state }
    },

    // Enable drain-based shutdown for the root actor when a timeout is configured
    ...(shutdownTimeoutMs !== undefined
      ? { shutdown: { drain: true, timeoutMs: shutdownTimeoutMs } }
      : {}),
  }

  const { handle: rootHandle, context: ctx } = createActor('system', rootDef, null, services)

  // ─── Spawn the internal metrics actor if configured ───
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

  // ─── Build the public facade ───

  const spawn = <M, S>(
    name: string,
    def: ActorDef<M, S>,
    initialState: S,
  ): ActorRef<M> => {
    if (shuttingDown) {
      throw new Error('Cannot spawn actors: system is shutting down')
    }
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

  // ─── Event Stream (infrastructure pass-throughs) ───

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

  // ─── Introspection (pass-throughs to MetricsRegistry) ───

  const getActorMetrics = (name: string): ActorSnapshot | undefined => {
    return metricsRegistry.snapshot(name)
  }

  const getAllActorMetrics = (): ActorSnapshot[] => {
    return metricsRegistry.snapshotAll()
  }

  const getActorTree = (): ActorTreeNode[] => {
    return metricsRegistry.actorTree()
  }

  return {
    spawn, stop, shutdown, publish, subscribe,
    getActorMetrics, getAllActorMetrics, getActorTree,
  }
}
