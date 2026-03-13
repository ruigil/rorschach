import { createMailbox } from './mailbox.ts'
import { createTimers } from './timers.ts'
import {
  STOP,
  DeadLetterTopic,
  LogTopic,
  type ActorContext,
  type ActorDef,
  type ActorIdentity,
  type ActorRef,
  type ActorServices,
  type EventTopic,
  type InternalActorHandle,
  type LifecycleEvent,
  type LogEvent,
  type LogLevel,
  type SupervisionStrategy,
} from './types.ts'

// ─── Internal envelope: unifies user messages and lifecycle events ───
type Envelope<M> =
  | { tag: 'message'; payload: M }
  | { tag: 'lifecycle'; event: LifecycleEvent }

/**
 * Creates an actor instance.
 *
 * Returns an InternalActorHandle with the public ActorRef and a stop() function
 * for the parent/system to manage the actor's lifecycle.
 *
 * The actor's state is entirely enclosed in the async processing loop closure.
 * No external code can read or mutate it.
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

  // ─── Build the public ActorRef ───
  const ref: ActorRef<M> = {
    name,
    send: (message: M) => {
      if (!stopped) {
        mailbox.enqueue({ tag: 'message', payload: message })
      } else {
        // Dead letter: message sent to a stopped actor
        services.eventStream.publish(DeadLetterTopic, {
          recipient: name,
          message,
          timestamp: Date.now(),
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
      services.watchService.watch(name, fullName, enqueueLifecycle)

      return childHandle.ref
    },

    stop: (child: ActorIdentity) => {
      const childHandle = children.get(child.name)
      if (childHandle) {
        children.delete(child.name)
        // Stop is async but we fire-and-forget here.
        // The terminated notification will arrive through the watch service.
        childHandle.stop()
      }
    },

    watch: (target: ActorIdentity) => {
      // If target is already dead (not in registry), deliver terminated immediately
      if (!services.registry.lookup(target.name)) {
        enqueueLifecycle({ type: 'terminated', ref: target, reason: 'stopped' })
        return
      }
      services.watchService.watch(name, target.name, enqueueLifecycle)
    },

    unwatch: (target: ActorIdentity) => {
      services.watchService.unwatch(name, target.name)
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

    // ─── Logging ───

    log: (() => {
      const makeLogger = (level: LogLevel) => (message: string, data?: unknown): void => {
        const logEvent: LogEvent = {
          level,
          source: name,
          message,
          timestamp: Date.now(),
          ...(data !== undefined ? { data } : {}),
        }
        services.eventStream.publish(LogTopic, logEvent)
      }
      return {
        debug: makeLogger('debug'),
        info: makeLogger('info'),
        warn: makeLogger('warn'),
        error: makeLogger('error'),
      }
    })(),
  }

  // ─── Supervision helpers ───
  const strategy: SupervisionStrategy = def.supervision ?? { type: 'stop' }

  // Tracks failure timestamps for windowed retry limiting
  const failureTimestamps: number[] = []

  /**
   * Determines whether a restart is still allowed under the configured limits.
   * Returns true if the actor should restart, false if retries are exhausted.
   */
  const canRestart = (): boolean => {
    if (strategy.type !== 'restart') return false

    const maxRetries = strategy.maxRetries
    if (maxRetries === undefined) return true // unlimited retries

    const now = Date.now()
    const windowMs = strategy.withinMs

    if (windowMs !== undefined) {
      // Sliding window: only count failures within the time window
      const cutoff = now - windowMs
      // Remove expired timestamps
      while (failureTimestamps.length > 0 && failureTimestamps[0]! < cutoff) {
        failureTimestamps.shift()
      }
    }

    failureTimestamps.push(now)
    return failureTimestamps.length <= maxRetries
  }

  /**
   * Stops all children and clears the children map.
   * Used during restart to give the actor a clean slate.
   */
  const stopAllChildren = async (): Promise<void> => {
    const stopPromises = Array.from(children.values()).map((child) => child.stop())
    await Promise.all(stopPromises)
    children.clear()
  }

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

    // Log: actor started
    services.eventStream.publish(LogTopic, {
      level: 'info', source: name, message: 'started', timestamp: Date.now(),
    } satisfies LogEvent)

    // Message processing loop
    while (true) {
      const envelope = await mailbox.take()

      // Mailbox closed — exit the loop
      if (envelope === STOP) break

      try {
        if (envelope.tag === 'message') {
          const result = await def.handler(state, envelope.payload, context)
          state = result.state

          // Auto-publish events returned from handler
          if (result.events) {
            for (const event of result.events) {
              services.eventStream.publish(name, event)
            }
          }
        } else if (envelope.tag === 'lifecycle') {
          if (def.lifecycle) {
            const result = await def.lifecycle(state, envelope.event, context)
            state = result.state
          }
        }
      } catch (error: unknown) {
        // ─── Supervision: apply strategy on failure ───
        switch (strategy.type) {
          case 'restart': {
            if (canRestart()) {
              // Log: restarting
              services.eventStream.publish(LogTopic, {
                level: 'warn', source: name, message: 'restarting',
                data: { error }, timestamp: Date.now(),
              } satisfies LogEvent)

              // Restart: cancel timers, stop children, reset state, re-run setup
              timers.cancelAll()
              await stopAllChildren()
              state = initialState
              if (def.setup) {
                state = await def.setup(state, context)
              }
              // Continue processing — the failed message is dropped
              continue
            }
            // Log: retries exhausted
            services.eventStream.publish(LogTopic, {
              level: 'error', source: name, message: 'failed (retries exhausted)',
              data: { error }, timestamp: Date.now(),
            } satisfies LogEvent)

            // Retries exhausted — stop with failure reason
            stopReason = 'failed'
            stopError = error
            break
          }

          case 'stop':
          default: {
            // Log: failed
            services.eventStream.publish(LogTopic, {
              level: 'error', source: name, message: 'failed',
              data: { error }, timestamp: Date.now(),
            } satisfies LogEvent)

            // Stop the actor — watchers will be notified with reason 'failed'
            stopReason = 'failed'
            stopError = error
            break
          }
        }

        // Strategy resolved to stop — exit the processing loop
        break
      }
    }

    // ─── Stopping phase ───

    // 1. Cancel all timers to prevent stale deliveries
    timers.cancelAll()

    // 2. Stop all children (top-down) and wait for them
    await stopAllChildren()

    // 3. Fire the 'stopped' lifecycle event (self teardown)
    if (def.lifecycle) {
      const result = await def.lifecycle(state, { type: 'stopped' }, context)
      state = result.state
    }

    // 4. Notify all watchers of this actor that it has terminated
    services.watchService.notifyWatchers(name, stopReason, stopError)

    // 5. Clean up all watches this actor holds (and remove forward map entry)
    services.watchService.cleanup(name)

    // 6. Clean up all event stream subscriptions
    services.eventStream.cleanup(name)

    // Log: stopped
    services.eventStream.publish(LogTopic, {
      level: 'info', source: name, message: 'stopped', timestamp: Date.now(),
    } satisfies LogEvent)

    // 7. Unregister from the global registry
    services.registry.unregister(name)
  })()

  return {
    ref,
    stop: async () => {
      if (stopped) return
      stopped = true
      mailbox.close()
      await runningPromise
    },
  }
}
