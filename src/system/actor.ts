import { createMailbox } from './mailbox.ts'
import { createTimers } from './timers.ts'
import { createSupervisionPolicy } from './supervision.ts'
import { watchTopic } from './eventstream.ts'
import {
  STOP,
  DeadLetterTopic,
  LogTopic,
  type ActorContext,
  type ActorDef,
  type ActorIdentity,
  type ActorRef,
  type ActorServices,
  type EventStream,
  type EventTopic,
  type InternalActorHandle,
  type LifecycleEvent,
  type LogEvent,
  type LogLevel,
  type StopResult,
} from './types.ts'

// ─── Internal envelope: unifies user messages and lifecycle events ───
type Envelope<M> =
  | { tag: 'message'; payload: M }
  | { tag: 'lifecycle'; event: LifecycleEvent }

// ─── Internal logger: reduces repetition in the processing loop ───
const createInternalLog = (source: string, eventStream: EventStream) => {
  const emit = (level: LogLevel, message: string, data?: unknown): void => {
    const logEvent: LogEvent = {
      level, source, message, timestamp: Date.now(),
      ...(data !== undefined ? { data } : {}),
    }
    eventStream.publish(LogTopic, logEvent)
  }
  return {
    debug: (msg: string, data?: unknown) => emit('debug', msg, data),
    info:  (msg: string, data?: unknown) => emit('info', msg, data),
    warn:  (msg: string, data?: unknown) => emit('warn', msg, data),
    error: (msg: string, data?: unknown) => emit('error', msg, data),
  }
}

/**
 * Creates an actor instance.
 *
 * Returns an InternalActorHandle with the public ActorRef and a stop() function
 * for the parent/system to manage the actor's lifecycle.
 *
 * The actor's state is entirely enclosed in the async processing loop closure.
 * No external code can read or mutate it.
 *
 */
export const createActor = <M, S>(
  name: string,
  def: ActorDef<M, S>,
  initialState: S,
  services: ActorServices,
): InternalActorHandle<M> => {
  // Single unified mailbox for both messages and lifecycle events
  const mailbox = createMailbox<Envelope<M>>()
  const children = new Map<string, InternalActorHandle>()
  let stopped = false

  // Internal logger for lifecycle events
  const log = createInternalLog(name, services.eventStream)

  // ─── Build the public ActorRef ───
  const ref: ActorRef<M> = {
    name,
    send: (message: M) => {
      if (!stopped) {
        mailbox.enqueue({ tag: 'message', payload: message })
      } else {
        services.eventStream.publish(DeadLetterTopic, {
          recipient: name, message, timestamp: Date.now(),
        })
      }
    },
  }

  // ─── Internal: enqueue a lifecycle event into the unified mailbox ───
  const enqueueLifecycle = (event: LifecycleEvent): void => {
    if (!stopped) {
      mailbox.enqueue({ tag: 'lifecycle', event })
    }
  }

  // ─── Build timers (scoped to this actor's lifecycle) ───
  const timers = createTimers<M>((message) => {
    if (!stopped) {
      mailbox.enqueue({ tag: 'message', payload: message })
    }
  })

  // ─── Stop all children and clear the map ───
  const stopAllChildren = async (): Promise<void> => {
    const stopPromises = Array.from(children.values()).map((child) => child.stop())
    await Promise.all(stopPromises)
    children.clear()
  }

  // ─── Build the context ───
  const context: ActorContext<M> = {
    self: ref,
    timers,

    spawn: <CM, CS>(
      childName: string,
      childDef: ActorDef<CM, CS>,
      childInitialState: CS,
    ): ActorRef<CM> => {
      const fullName = `${name}/${childName}`

      if (children.has(fullName)) {
        throw new Error(`Actor "${fullName}" already exists as a child of "${name}"`)
      }

      const childHandle = createActor(fullName, childDef, childInitialState, services)
      children.set(fullName, childHandle as InternalActorHandle)

      // Parent implicitly watches its children
      services.eventStream.subscribe(name, watchTopic(fullName), enqueueLifecycle as (event: unknown) => void)

      return childHandle.ref
    },

    stop: (child: ActorIdentity) => {
      const childHandle = children.get(child.name)
      if (childHandle) {
        children.delete(child.name)
        childHandle.stop()
      }
    },

    watch: (target: ActorIdentity) => {
      if (!services.registry.lookup(target.name)) {
        enqueueLifecycle({ type: 'terminated', ref: target, reason: 'stopped' })
        return
      }
      services.eventStream.subscribe(name, watchTopic(target.name), enqueueLifecycle as (event: unknown) => void)
    },

    unwatch: (target: ActorIdentity) => {
      services.eventStream.unsubscribe(name, watchTopic(target.name))
    },

    lookup: <T = unknown>(targetName: string) => {
      return services.registry.lookup<T>(targetName)
    },

    // ─── Event Stream (pub-sub) ───

    publish: (topic: EventTopic, event: unknown) => {
      services.eventStream.publish(topic, event)
    },

    subscribe: (topic: EventTopic, adapter: (event: unknown) => M) => {
      services.eventStream.subscribe(name, topic, (event) => {
        if (!stopped) {
          mailbox.enqueue({ tag: 'message', payload: adapter(event) })
        }
      })
    },

    unsubscribe: (topic: EventTopic) => {
      services.eventStream.unsubscribe(name, topic)
    },

    // ─── Logging (exposed to actor handlers) ───

    log,
  }

  // ─── Supervision policy ───
  const policy = createSupervisionPolicy(def.supervision ?? { type: 'stop' })

  // Track termination reason for watchers
  let stopReason: 'stopped' | 'failed' = 'stopped'
  let stopError: unknown = undefined

  // ─── The async processing loop ───
  const runningPromise = (async () => {
    let state = initialState

    // Setup phase
    if (def.setup) {
      state = await def.setup(state, context)
    }

    // Register in the global registry now that setup is complete
    services.registry.register(name, ref as ActorRef<unknown>)
    log.info('started')

    // Message processing loop
    while (true) {
      const envelope = await mailbox.take()

      // Mailbox closed — exit the loop
      if (envelope === STOP) break

      try {
        if (envelope.tag === 'message') {
          const result = await def.handler(state, envelope.payload, context)
          state = result.state

          if (result.events) {
            for (const event of result.events) {
              services.eventStream.publish(name, event)
            }
          }
        } else if (envelope.tag === 'lifecycle') {
          // Auto-remove terminated children from the children map
          if (envelope.event.type === 'terminated') {
            children.delete(envelope.event.ref.name)
          }

          if (def.lifecycle) {
            const result = await def.lifecycle(state, envelope.event, context)
            state = result.state
          }
        }
      } catch (error: unknown) {
        const decision = policy.onFailure()

        if (decision === 'restart') {
          log.warn('restarting', { error })

          // Restart: cancel timers, stop children, reset state, re-run setup
          timers.cancelAll()
          await stopAllChildren()
          state = initialState
          if (def.setup) {
            state = await def.setup(state, context)
          }
          continue
        }

        // Decision is 'stop' — either strategy is stop, or retries exhausted
        log.error('failed', { error })
        stopReason = 'failed'
        stopError = error
        break
      }
    }

    // ─── Stopping phase ───

    // 1. Cancel all timers
    timers.cancelAll()

    // 2. Unsubscribe from child watch topics — terminated events will be
    //    delivered directly below via the StopResult returned by child.stop().
    for (const [childName] of children) {
      services.eventStream.unsubscribe(name, watchTopic(childName))
    }

    // 3. Stop each child and deliver its terminated event directly
    for (const [childName, child] of children) {
      const { reason, error } = await child.stop()
      if (def.lifecycle) {
        const event: LifecycleEvent = {
          type: 'terminated',
          ref: { name: childName },
          reason,
          ...(error !== undefined ? { error } : {}),
        }
        const result = await def.lifecycle(state, event, context)
        state = result.state
      }
    }
    children.clear()

    // 4. Fire the 'stopped' lifecycle event (self teardown)
    if (def.lifecycle) {
      const result = await def.lifecycle(state, { type: 'stopped' }, context)
      state = result.state
    }

    // 5. Notify watchers
    const terminatedEvent: LifecycleEvent = {
      type: 'terminated',
      ref: { name },
      reason: stopReason,
      ...(stopError !== undefined ? { error: stopError } : {}),
    }
    services.eventStream.publish(watchTopic(name), terminatedEvent)

    // 6. Clean up subscriptions (both domain and watch) + watch topic forward entry, registry
    services.eventStream.cleanup(name)
    services.eventStream.deleteTopic(watchTopic(name))
    log.info('stopped')
    services.registry.unregister(name)
  })()

  return {
    ref,
    stop: async (): Promise<StopResult> => {
      if (stopped) return { reason: stopReason, ...(stopError !== undefined ? { error: stopError } : {}) }
      stopped = true
      mailbox.close()
      await runningPromise
      return { reason: stopReason, ...(stopError !== undefined ? { error: stopError } : {}) }
    },
  }
}
