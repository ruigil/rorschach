import { createMailbox } from './mailbox.ts'
import { createTimers } from './timers.ts'
import { createActorMetrics } from './metrics.ts'
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
  type Interceptor,
  type InternalActorHandle,
  type LifecycleEvent,
  type LogEvent,
  type LogLevel,
  type Mailbox,
  type MessageHeaders,
  type MessageHandler,
  type SpanHandle,
  type StopResult,
  type SupervisionStrategy,
  type TraceContext,
} from './types.ts'
import { TraceTopic, newId } from './trace.ts'

// ─── Internal envelope: unifies user messages and lifecycle events ───
type Envelope<M> =
  | { tag: 'message'; payload: M; headers: MessageHeaders }
  | { tag: 'lifecycle'; event: LifecycleEvent }

// ─── Stashed envelope: preserves headers alongside the deferred message ───
type StashedEnvelope<M> = { payload: M; headers: MessageHeaders }

// ─── Internal logger type ───
type InternalLog = {
  readonly debug: (msg: string, data?: unknown) => void
  readonly info:  (msg: string, data?: unknown) => void
  readonly warn:  (msg: string, data?: unknown) => void
  readonly error: (msg: string, data?: unknown) => void
}


/**
 * A supervision policy encapsulates the retry-window and backoff logic for an actor.
 *
 * On each failure, call `onFailure()` to determine whether to restart or stop,
 * and how long to wait before restarting. Call `onSuccess()` after each
 * successfully processed message to reset the consecutive-failure counter
 * (so backoff starts fresh after a period of healthy operation).
 */
type SupervisionPolicy = {
  /** Returns the action and backoff delay to apply before restarting. */
  readonly onFailure: () => { action: 'restart' | 'stop'; delayMs: number }
  /** Resets the consecutive-failure counter used for backoff calculation. */
  readonly onSuccess: () => void
}

// Computes exponential backoff: backoffMs * 2^attempt, capped at maxBackoffMs.
const computeBackoff = (backoffMs: number | undefined, maxBackoffMs: number | undefined, attempt: number): number => {
  if (backoffMs === undefined) return 0
  const delay = backoffMs * Math.pow(2, attempt)
  return maxBackoffMs !== undefined ? Math.min(delay, maxBackoffMs) : delay
}

/**
 * Creates a supervision policy from a strategy definition.
 *
 * - `{ type: 'stop' }` — always returns 'stop'
 * - `{ type: 'restart' }` — returns 'restart', optionally bounded by maxRetries/withinMs,
 *   with optional exponential backoff via backoffMs/maxBackoffMs
 */
const createSupervisionPolicy = (strategy: SupervisionStrategy): SupervisionPolicy => {
  if (strategy.type === 'stop') {
    return {
      onFailure: () => ({ action: 'stop', delayMs: 0 }),
      onSuccess: () => {},
    }
  }

  // Restart strategy — track failure timestamps for windowed retry limiting
  const failureTimestamps: number[] = []
  const { maxRetries, withinMs, backoffMs, maxBackoffMs } = strategy

  // Tracks consecutive failures for backoff calculation — reset on success
  let consecutiveFailures = 0

  const onFailure = (): { action: 'restart' | 'stop'; delayMs: number } => {
    const delayMs = computeBackoff(backoffMs, maxBackoffMs, consecutiveFailures)
    consecutiveFailures++

    if (maxRetries === undefined) return { action: 'restart', delayMs } // unlimited retries

    const now = Date.now()

    if (withinMs !== undefined) {
      // Sliding window: only count failures within the time window
      const cutoff = now - withinMs
      while (failureTimestamps.length > 0 && failureTimestamps[0]! < cutoff) {
        failureTimestamps.shift()
      }
    }

    failureTimestamps.push(now)
    return failureTimestamps.length <= maxRetries
      ? { action: 'restart', delayMs }
      : { action: 'stop', delayMs: 0 }
  }

  const onSuccess = (): void => {
    consecutiveFailures = 0
  }

  return { onFailure, onSuccess }
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
  readonly getHeaders: () => MessageHeaders
  readonly configRef: { value: unknown } | undefined
}

/**
 * Builds the `ActorContext<M>` — the API surface exposed to actor handlers.
 *
 * Pure wiring: takes the actor's internal plumbing and wraps it into the
 * context interface. No mutable state of its own.
 */
const createActorContext = <M>(internals: ActorInternals<M>): ActorContext<M> => {
  const { name, ref, timers, children, mailbox, services,
          enqueueLifecycle, log, isStopped, getHeaders, configRef } = internals

  // ─── Tracing ───

  const makeSpan = (
    traceId: string,
    spanId: string,
    parentSpanId: string | undefined,
    operation: string,
    data?: Record<string, unknown>,
  ): SpanHandle => {
    const startTime = Date.now()
    services.eventStream.publish(TraceTopic, {
      traceId, spanId, actor: name, operation,
      status: 'started', timestamp: startTime,
      ...(parentSpanId !== undefined ? { parentSpanId } : {}),
      ...(data !== undefined ? { data } : {}),
    })
    return {
      traceId,
      spanId,
      done: (doneData?: Record<string, unknown>) => {
        const now = Date.now()
        services.eventStream.publish(TraceTopic, {
          traceId, spanId, actor: name, operation,
          status: 'done', timestamp: now, durationMs: now - startTime,
          ...(parentSpanId !== undefined ? { parentSpanId } : {}),
          ...(doneData !== undefined ? { data: doneData } : {}),
        })
      },
      error: (err?: unknown) => {
        const now = Date.now()
        services.eventStream.publish(TraceTopic, {
          traceId, spanId, actor: name, operation,
          status: 'error', timestamp: now, durationMs: now - startTime,
          ...(parentSpanId !== undefined ? { parentSpanId } : {}),
          ...(err !== undefined ? { data: { error: String(err) } } : {}),
        })
      },
    }
  }

  const traceCtx: TraceContext = {
    start: (operation, data) => makeSpan(newId(), newId(), undefined, operation, data),
    child: (traceId, parentSpanId, operation, data) => makeSpan(traceId, newId(), parentSpanId, operation, data),
    fromHeaders: () => {
      const traceparent = getHeaders()['traceparent']
      if (!traceparent) return null
      const parts = traceparent.split('-')
      if (parts.length < 4) return null
      return { traceId: parts[1]!, spanId: parts[2]! }
    },
    injectHeaders: (span) => ({
      traceparent: `00-${span.traceId}-${span.spanId}-01`,
    }),
  }

  return {
    self: ref,
    timers,
    messageHeaders: () => getHeaders(),
    initialConfig: () => { return configRef?.value },

    spawn: <CM, CS>(
      childName: string,
      childDef: ActorDef<CM, CS>,
      childInitialState: CS,
      options?: { config?: unknown },
    ): ActorRef<CM> => {
      const fullName = `${name}/${childName}`

      if (children.has(fullName)) {
        throw new Error(`Actor "${fullName}" already exists as a child of "${name}"`)
      }

      const childConfigRef = options?.config !== undefined ? { value: options.config } : undefined
      const { handle: childHandle } = createActor(fullName, childDef, childInitialState, services, childConfigRef)
      children.set(fullName, childHandle as InternalActorHandle)

      // Parent implicitly watches its children
      services.eventStream.subscribe(name, watchTopic(fullName), enqueueLifecycle)

      return childHandle.ref
    },

    stop: (child: ActorIdentity) => {
      const childHandle = children.get(child.name)
      if (childHandle) {
        children.delete(child.name)
        childHandle.stop()
      }
    },

    watch: (target: ActorRef<unknown>) => {
      if (!target.isAlive()) {
        enqueueLifecycle({ type: 'terminated', ref: target, reason: 'stopped' })
        return
      }
      services.eventStream.subscribe(name, watchTopic(target.name), enqueueLifecycle)
    },

    unwatch: (target: ActorRef<unknown>) => {
      services.eventStream.unsubscribe(name, watchTopic(target.name))
    },

    // ─── Event Stream (pub-sub) ───

    publish: <T>(topic: EventTopic<T>, event: T) => {
      services.eventStream.publish(topic, event)
    },

    publishRetained: <T>(topic: EventTopic<T>, key: string, event: T) => {
      services.eventStream.publishRetained(topic, key, event)
    },

    deleteRetained: <T>(topic: EventTopic<T>, key: string, tombstone: T) => {
      services.eventStream.deleteRetained(topic, key, tombstone)
    },

    subscribe: <T>(topic: EventTopic<T>, adapter: (event: T) => M) => {
      services.eventStream.subscribe(name, topic, (event: T) => {
        if (!isStopped()) {
          mailbox.enqueue({ tag: 'message', payload: adapter(event), headers: {} })
        }
      })
    },

    unsubscribe: (topic: EventTopic) => {
      services.eventStream.unsubscribe(name, topic)
    },

    deleteTopic: (topic: EventTopic) => {
      services.eventStream.deleteTopic(topic)
    },

    // ─── Async Effects ───

    pipeToSelf: <T>(
      future: Promise<T>,
      onSuccess: (value: T) => M,
      onFailure: (error: unknown) => M,
    ): void => {
      const capturedHeaders = getHeaders()
      future.then(
        (value) => {
          if (!isStopped()) {
            mailbox.enqueueSystem({ tag: 'message', payload: onSuccess(value), headers: capturedHeaders })
          }
        },
        (error) => {
          if (!isStopped()) {
            mailbox.enqueueSystem({ tag: 'message', payload: onFailure(error), headers: capturedHeaders })
          }
        },
      )
    },

    // ─── Introspection ───

    actorSnapshots: () => services.metricsRegistry.snapshotAll(),
    topicSnapshots: () => services.eventStream.snapshot(),

    // ─── Logging (exposed to actor handlers) ───

    log,
    trace: traceCtx,
  }
}

/**
 * Composes interceptors around a message handler into a single pipeline.
 *
 * Interceptors are applied right-to-left: the first interceptor in the array
 * is the outermost wrapper, the last is closest to the handler.
 *
 * When no interceptors are provided, returns the handler unchanged (zero overhead).
 */
const buildPipeline = <M, S>(
  handler: MessageHandler<M, S>,
  interceptors: Interceptor<M, S>[] | undefined,
): MessageHandler<M, S> => {
  if (!interceptors || interceptors.length === 0) return handler

  // Start with the real handler as the innermost "next"
  let pipeline: (state: S, message: M, context: ActorContext<M>) => ReturnType<MessageHandler<M, S>> = handler

  // Wrap from right to left
  for (let i = interceptors.length - 1; i >= 0; i--) {
    const interceptor = interceptors[i]!
    const next = pipeline
    pipeline = (state, message, context) =>
      interceptor(state, message, context, (s, m) => next(s, m, context))
  }

  return pipeline
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
type ActorCreationResult<M> = {
  readonly handle: InternalActorHandle<M>
  readonly context: ActorContext<M>
}

export const createActor = <M, S>(
  name: string,
  def: ActorDef<M, S>,
  initialState: S,
  services: ActorServices,
  configRef?: { value: unknown },
): ActorCreationResult<M> => {
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
  let currentHeaders: MessageHeaders = {}

  // ─── Build the public ActorRef ───
  const ref: ActorRef<M> = {
    name,
    send: (message: M, headers: MessageHeaders = {}) => {
      if (!stopped) {
        metrics.recordMessageReceived()
        mailbox.enqueue({ tag: 'message', payload: message, headers })
      } else {
        services.eventStream.publish(DeadLetterTopic, {
          recipient: name, message, timestamp: Date.now(),
        })
      }
    },
    isAlive: () => !stopped,
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
      mailbox.enqueueSystem({ tag: 'message', payload: message, headers: {} })
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
    enqueueLifecycle, log, isStopped: () => stopped, getHeaders: () => currentHeaders,
    configRef,
  })

  // ─── Supervision policy ───
  const policy = createSupervisionPolicy(def.supervision ?? { type: 'stop' })

  // Track termination reason for watchers
  let stopReason: 'stopped' | 'failed' = 'stopped'
  let stopError: unknown = undefined

  // ─── Stopping phase ───
  const runShutdownSequence = async (state: S) => {
    // Update metrics status (preserve 'failed' if already set)
    if (stopReason !== 'failed') {
      metrics.setStatus('stopping')
    }

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

    // 6. Clean up subscriptions (both domain and watch) + watch topic forward entry
    services.eventStream.cleanup(name)
    services.eventStream.deleteTopic(watchTopic(name))
    log.info('stopped')

    // 7. Finalize metrics status and unregister
    if (stopReason !== 'failed') {
      metrics.setStatus('stopped')
    }
    services.metricsRegistry.unregister(name)
  }

  // ─── Stash size — shared between the processing loop and metrics gauge ───
  let currentStashSize = 0

  // ─── Current state — shared between the processing loop and metrics gauge ───
  let currentStateSnapshot: unknown = initialState

  // ─── Actor Metrics ───
  const metrics = createActorMetrics(name, {
    mailboxSize: () => mailbox.size(),
    stashSize: () => currentStashSize,
    childCount: () => children.size,
    children: () => Array.from(children.keys()),
    getState: () => def.maskState ? def.maskState(currentStateSnapshot as S) : currentStateSnapshot,
  })

  // ─── Stash capacity ───
  const stashCapacity = def.stashCapacity ?? 1000

  // ─── Helper: dead-letter all stashed messages and clear the buffer ───
  const drainStashToDeadLetters = (stashedMessages: StashedEnvelope<M>[]): void => {
    for (const { payload } of stashedMessages) {
      services.eventStream.publish(DeadLetterTopic, {
        recipient: name, message: payload, timestamp: Date.now(),
      })
    }
    stashedMessages.length = 0
  }

  // ─── The async processing loop ───
  const runningPromise = (async () => {
    let state = initialState

    // ─── Behavior switching: current handler (starts as def.handler, wrapped with interceptors) ───
    let currentHandler: MessageHandler<M, S> = buildPipeline(def.handler, def.interceptors)

    // ─── Stash buffer: messages deferred by the current behavior ───
    const stashedMessages: StashedEnvelope<M>[] = []

    // Startup phase — load persisted snapshot, register, then deliver the
    // 'start' lifecycle event so the actor can initialize resources.
    // Wrapped in try/catch so a throwing start handler is handled by the same
    // supervised shutdown path as any other failure.
    try {
      if (def.persistence) {
        const loaded = await def.persistence.load()
        if (loaded !== undefined) state = loaded
      }
      currentStateSnapshot = state
      services.metricsRegistry.register(name, metrics)
      if (def.lifecycle) {
        const result = await def.lifecycle(state, { type: 'start' }, context)
        state = result.state
        currentStateSnapshot = state
      }
      log.info('started')
    } catch (startupError: unknown) {
      log.error('failed — start lifecycle threw', { error: startupError })
      metrics.setStatus('failed')
      stopReason = 'failed'
      stopError = startupError
      drainStashToDeadLetters(stashedMessages)
      await runShutdownSequence(state)
      return
    }

    // Message processing loop
    while (true) {
      const envelope = await mailbox.take()

      // Mailbox closed — exit the loop
      if (envelope === STOP) break

      try {
        if (envelope.tag === 'message') {
          currentHeaders = envelope.headers
          const startTime = performance.now()
          const result = currentHandler(state, envelope.payload, context)
          metrics.recordMessageProcessed(performance.now() - startTime)
          policy.onSuccess()
          state = result.state
          currentStateSnapshot = state

          // ─── Behavior switching (re-wrap with interceptors) ───
          if (result.become) {
            currentHandler = buildPipeline(result.become as MessageHandler<M, S>, def.interceptors)
          }

          // ─── Stashing ───
          if (result.stash) {
            if (stashedMessages.length >= stashCapacity) {
              // Drop oldest stashed message to dead letters to make room
              const dropped = stashedMessages.shift()!
              services.eventStream.publish(DeadLetterTopic, {
                recipient: name, message: dropped.payload, timestamp: Date.now(),
              })
              log.warn('stash overflow — oldest message dropped', {
                stashSize: stashedMessages.length,
                stashCapacity,
              })
            }
            stashedMessages.push({ payload: envelope.payload, headers: envelope.headers })
          }

          if (result.unstashAll && stashedMessages.length > 0) {
            for (const { payload, headers } of stashedMessages.splice(0)) {
              mailbox.enqueueSystem({ tag: 'message', payload, headers })
            }
          }

          // ─── Update stash size gauge ───
          currentStashSize = stashedMessages.length

          if (result.events) {
            for (const { topic, payload } of result.events) {
              services.eventStream.publish(topic, payload)
            }
          }

          // ─── Persistence: snapshot state after successful message ───
          if (def.persistence) {
            try {
              await def.persistence.save(state)
            } catch (saveError: unknown) {
              log.warn('persistence save failed — continuing', { error: saveError })
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
            currentStateSnapshot = state
          }
        }
      } catch (error: unknown) {
        metrics.recordMessageFailed()
        const { action, delayMs } = policy.onFailure()

        if (action === 'restart') {
          metrics.recordRestart()
          log.warn('restarting', { error, ...(delayMs > 0 ? { backoffMs: delayMs } : {}) })

          // Restart: cancel timers, stop children, reset state, re-run setup
          timers.cancelAll()
          await stopAllChildren()

          // Reset behavior (re-wrap with interceptors) and dead-letter stashed messages
          currentHandler = buildPipeline(def.handler, def.interceptors)
          drainStashToDeadLetters(stashedMessages)
          currentStashSize = 0

          try {
            if (delayMs > 0) {
              await new Promise<void>(resolve => setTimeout(resolve, delayMs))
            }

            state = initialState
            if (def.persistence) {
              const loaded = await def.persistence.load()
              if (loaded !== undefined) state = loaded
            }
            currentStateSnapshot = state
            if (def.lifecycle) {
              const result = await def.lifecycle(state, { type: 'start' }, context)
              state = result.state
              currentStateSnapshot = state
            }
          } catch (restartError: unknown) {
            log.error('failed — start lifecycle threw during restart', { error: restartError })
            metrics.setStatus('failed')
            stopReason = 'failed'
            stopError = restartError
            break
          }

          continue
        }

        // Decision is 'stop' — either strategy is stop, or retries exhausted
        log.error('failed', { error })
        metrics.setStatus('failed')
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
    handle: {
      ref,
      stop: async (): Promise<StopResult> => {
      if (stopped) return { reason: stopReason, ...(stopError !== undefined ? { error: stopError } : {}) }
      stopped = true

      const shutdownConfig = def.shutdown

      if (shutdownConfig?.drain) {
        // ─── Graceful shutdown: drain remaining messages before stopping ───

        // 1. Deliver 'stopping' lifecycle event into the mailbox
        //    (uses enqueueSystem — bypasses capacity limits, works because
        //     mailbox is not yet closed/drained)
        mailbox.enqueueSystem({ tag: 'lifecycle', event: { type: 'stopping' } })

        // 2. Switch to drain mode — no new messages via enqueue(),
        //    but existing queue + system messages are still processed.
        mailbox.drain()

        // 3. Safety timeout: force-close the mailbox if drain takes too long
        let drainTimer: ReturnType<typeof setTimeout> | undefined
        if (shutdownConfig.timeoutMs !== undefined) {
          drainTimer = setTimeout(() => {
            log.warn('shutdown drain timed out — force closing', {
              timeoutMs: shutdownConfig.timeoutMs,
            })
            mailbox.close()
          }, shutdownConfig.timeoutMs)
        }

        await runningPromise

        // Clear the safety timer if drain completed before timeout
        if (drainTimer !== undefined) clearTimeout(drainTimer)
      } else {
        // ─── Immediate shutdown (existing behavior) ───
        mailbox.close()
        await runningPromise
      }

      return { reason: stopReason, ...(stopError !== undefined ? { error: stopError } : {}) }
      },
    },
    context,
  }
}
