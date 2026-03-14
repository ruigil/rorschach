import { createActor } from './actor.ts'
import { createEventStream, createRegistry } from './services.ts'
import type {
  ActorContext,
  ActorDef,
  ActorIdentity,
  ActorRef,
  ActorServices,
  ActorSystem,
  EventTopic,
  LifecycleEvent,
} from './types.ts'

/**
 * Optional handler for system-level lifecycle events.
 * Receives `terminated` events from top-level actors (children of the root).
 */
export type SystemLifecycleHandler = (event: LifecycleEvent) => void

/**
 * Options for creating an actor system.
 */
export type ActorSystemOptions = {
  /** Optional handler for lifecycle events from top-level actors. */
  onLifecycle?: SystemLifecycleHandler
  /**
   * Maximum time (in ms) to wait for the root actor's drain to complete
   * during `shutdown()`. If the drain hasn't finished by this deadline,
   * the root actor's mailbox is force-closed.
   * Only meaningful when the root actor uses drain-based shutdown (default).
   */
  shutdownTimeoutMs?: number
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
 * `publish` and `subscribe` are convenience pass-throughs to the shared
 * event stream infrastructure — they are not root actor capabilities.
 */
export const createActorSystem = (
  optionsOrLifecycle?: ActorSystemOptions | SystemLifecycleHandler,
): ActorSystem => {
  // Support both the legacy signature (bare callback) and the new options object
  const options: ActorSystemOptions =
    typeof optionsOrLifecycle === 'function'
      ? { onLifecycle: optionsOrLifecycle }
      : optionsOrLifecycle ?? {}

  const { onLifecycle, shutdownTimeoutMs } = options
  let shuttingDown = false

  // Shared infrastructure
  const services: ActorServices = {
    registry: createRegistry(),
    eventStream: createEventStream(),
  }

  // ─── Root actor context, captured synchronously during setup ───
  let rootContext: ActorContext<never> | null = null

  const rootDef: ActorDef<never, null> = {
    setup: (state, context) => {
      rootContext = context
      return state
    },

    handler: (state) => ({ state }),

    lifecycle: (state, event) => {
      // Only forward child terminated events to the external callback,
      // not the root actor's own 'stopped' or 'stopping' events.
      if (event.type === 'terminated') {
        onLifecycle?.(event)
      }
      return { state }
    },

    // Enable drain-based shutdown for the root actor when a timeout is configured
    ...(shutdownTimeoutMs !== undefined
      ? { shutdown: { drain: true, timeoutMs: shutdownTimeoutMs } }
      : {}),
  }

  const rootHandle = createActor('system', rootDef, null, services)

  // rootContext is guaranteed to be set: createActor calls def.setup()
  // synchronously within the async IIFE before the first await yields.
  const ctx = rootContext!

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

  const publish = (topic: EventTopic, event: unknown): void => {
    services.eventStream.publish(topic, event)
  }

  const subscribe = (
    subscriberName: string,
    topic: EventTopic,
    callback: (event: unknown) => void,
  ): (() => void) => {
    services.eventStream.subscribe(subscriberName, topic, callback)
    return () => services.eventStream.unsubscribe(subscriberName, topic)
  }

  return { spawn, stop, shutdown, publish, subscribe }
}
