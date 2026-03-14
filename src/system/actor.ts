import { createMailbox } from './mailbox.ts'
import { createTimers } from './timers.ts'
import { watchTopic } from './services.ts'
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
  type Mailbox,
  type MessageHandler,
  type StopResult,
  type SupervisionStrategy
} from './types.ts'

// ─── Internal envelope: unifies user messages and lifecycle events ───
type Envelope<M> =
  | { tag: 'message'; payload: M }
  | { tag: 'lifecycle'; event: LifecycleEvent }

// ─── Internal logger type ───
type InternalLog = {
  readonly debug: (msg: string, data?: unknown) => void
  readonly info:  (msg: string, data?: unknown) => void
  readonly warn:  (msg: string, data?: unknown) => void
  readonly error: (msg: string, data?: unknown) => void
}


/**
 * A supervision policy encapsulates the retry-window logic for an actor.
 *
 * On each failure, call `onFailure()` to determine whether to restart or stop.
 * The policy tracks failure timestamps internally for windowed retry limiting.
 */
export type SupervisionPolicy = {
  /** Returns 'restart' if the actor should restart, 'stop' if retries are exhausted or strategy is stop. */
  readonly onFailure: () => 'restart' | 'stop'
}

/**
 * Creates a supervision policy from a strategy definition.
 *
 * - `{ type: 'stop' }` — always returns 'stop'
 * - `{ type: 'restart' }` — returns 'restart', optionally bounded by maxRetries/withinMs
 */
const createSupervisionPolicy = (strategy: SupervisionStrategy): SupervisionPolicy => {
  if (strategy.type === 'stop') {
    return { onFailure: () => 'stop' }
  }

  // Restart strategy — track failure timestamps for windowed retry limiting
  const failureTimestamps: number[] = []
  const { maxRetries, withinMs } = strategy

  const onFailure = (): 'restart' | 'stop' => {
    if (maxRetries === undefined) return 'restart' // unlimited retries

    const now = Date.now()

    if (withinMs !== undefined) {
      // Sliding window: only count failures within the time window
      const cutoff = now - withinMs
      while (failureTimestamps.length > 0 && failureTimestamps[0]! < cutoff) {
        failureTimestamps.shift()
      }
    }

    failureTimestamps.push(now)
    return failureTimestamps.length <= maxRetries ? 'restart' : 'stop'
  }

  return { onFailure }
}



// ─── Internal logger: reduces repetition in the processing loop ───
const createInternalLog = (source: string, eventStream: EventStream): InternalLog => {
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

// ─── Dependencies for context construction ───
//
// Bundles everything `createActorContext` needs from the actor's internals.
// The `isStopped` getter exposes the mutable `stopped` flag without leaking
// the `let` binding — context closures call it each time they need the value.
//
type ActorInternals<M> = {
  readonly name: string
  readonly ref: ActorRef<M>
  readonly timers: ReturnType<typeof createTimers<M>>
  readonly children: Map<string, InternalActorHandle>
  readonly mailbox: Mailbox<Envelope<M>>
  readonly services: ActorServices
  readonly enqueueLifecycle: (event: LifecycleEvent) => void
  readonly log: InternalLog
  readonly isStopped: () => boolean
}

/**
 * Builds the `ActorContext<M>` — the API surface exposed to actor handlers.
 *
 * Pure wiring: takes the actor's internal plumbing and wraps it into the
 * context interface. No mutable state of its own.
 */
const createActorContext = <M>(internals: ActorInternals<M>): ActorContext<M> => {
  const { name, ref, timers, children, mailbox, services,
          enqueueLifecycle, log, isStopped } = internals

  return {
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
        if (!isStopped()) {
          mailbox.enqueue({ tag: 'message', payload: adapter(event) })
        }
      })
    },

    unsubscribe: (topic: EventTopic) => {
      services.eventStream.unsubscribe(name, topic)
    },

    // ─── Async Effects ───

    pipeToSelf: <T>(
      future: Promise<T>,
      onSuccess: (value: T) => M,
      onFailure: (error: unknown) => M,
    ): void => {
      future.then(
        (value) => {
          if (!isStopped()) {
            mailbox.enqueueSystem({ tag: 'message', payload: onSuccess(value) })
          }
        },
        (error) => {
          if (!isStopped()) {
            mailbox.enqueueSystem({ tag: 'message', payload: onFailure(error) })
          }
        },
      )
    },

    // ─── Logging (exposed to actor handlers) ───

    log,
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
  // Internal logger for lifecycle events (created early so onOverflow can use it)
  const log = createInternalLog(name, services.eventStream)

  // Single unified mailbox for both messages and lifecycle events
  const mailbox = createMailbox<Envelope<M>>(
    def.mailbox?.capacity !== undefined
      ? {
          capacity: def.mailbox.capacity,
          overflowStrategy: def.mailbox.overflowStrategy,
          onOverflow: (dropped) => {
            // Route dropped messages to the dead-letter topic
            const envelope = dropped as Envelope<M> | undefined
            if (envelope && typeof envelope === 'object' && 'tag' in envelope && envelope.tag === 'message') {
              services.eventStream.publish(DeadLetterTopic, {
                recipient: name,
                message: envelope.payload,
                timestamp: Date.now(),
              })
            }
            log.warn('mailbox overflow — message dropped', {
              strategy: def.mailbox?.overflowStrategy ?? 'drop-newest',
              mailboxSize: mailbox.size(),
            })
          },
        }
      : undefined,
  )
  const children = new Map<string, InternalActorHandle>()
  let stopped = false

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
  // Lifecycle events bypass capacity limits — they must never be dropped.
  const enqueueLifecycle = (event: LifecycleEvent): void => {
    if (!stopped) {
      mailbox.enqueueSystem({ tag: 'lifecycle', event })
    }
  }

  // ─── Build timers (scoped to this actor's lifecycle) ───
  // Timer messages bypass capacity limits — the actor explicitly scheduled them.
  const timers = createTimers<M>((message) => {
    if (!stopped) {
      mailbox.enqueueSystem({ tag: 'message', payload: message })
    }
  })

  // ─── Stop all children and clear the map ───
  const stopAllChildren = async (): Promise<void> => {
    const stopPromises = Array.from(children.values()).map((child) => child.stop())
    await Promise.all(stopPromises)
    children.clear()
  }

  // ─── Build the context (extracted — pure wiring) ───
  const context = createActorContext<M>({
    name, ref, timers, children, mailbox, services,
    enqueueLifecycle, log, isStopped: () => stopped,
  })

  // ─── Supervision policy ───
  const policy = createSupervisionPolicy(def.supervision ?? { type: 'stop' })

  // Track termination reason for watchers
  let stopReason: 'stopped' | 'failed' = 'stopped'
  let stopError: unknown = undefined

  // ─── Stopping phase ───
  const runShutdownSequence = async (state: S) => {
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
  }

  // ─── Stash capacity ───
  const stashCapacity = def.stashCapacity ?? 1000

  // ─── Helper: dead-letter all stashed messages and clear the buffer ───
  const drainStashToDeadLetters = (stashedMessages: M[]): void => {
    for (const msg of stashedMessages) {
      services.eventStream.publish(DeadLetterTopic, {
        recipient: name, message: msg, timestamp: Date.now(),
      })
    }
    stashedMessages.length = 0
  }

  // ─── The async processing loop ───
  const runningPromise = (async () => {
    let state = initialState

    // ─── Behavior switching: current handler (starts as def.handler) ───
    let currentHandler: MessageHandler<M, S> = def.handler

    // ─── Stash buffer: messages deferred by the current behavior ───
    const stashedMessages: M[] = []

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
          const result = await currentHandler(state, envelope.payload, context)
          state = result.state

          // ─── Behavior switching ───
          if (result.become) {
            currentHandler = result.become as MessageHandler<M, S>
          }

          // ─── Stashing ───
          if (result.stash) {
            if (stashedMessages.length >= stashCapacity) {
              // Drop oldest stashed message to dead letters to make room
              const dropped = stashedMessages.shift()
              services.eventStream.publish(DeadLetterTopic, {
                recipient: name, message: dropped, timestamp: Date.now(),
              })
              log.warn('stash overflow — oldest message dropped', {
                stashSize: stashedMessages.length,
                stashCapacity,
              })
            }
            stashedMessages.push(envelope.payload)
          }

          if (result.unstashAll && stashedMessages.length > 0) {
            for (const msg of stashedMessages.splice(0)) {
              mailbox.enqueueSystem({ tag: 'message', payload: msg })
            }
          }

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

          // Reset behavior and dead-letter stashed messages
          currentHandler = def.handler
          drainStashToDeadLetters(stashedMessages)

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
    // Dead-letter any remaining stashed messages
    drainStashToDeadLetters(stashedMessages)

    await runShutdownSequence(state)
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
