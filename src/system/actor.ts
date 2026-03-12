import { createMailbox } from './mailbox.ts'
import { createTimers } from './timers.ts'
import {
  STOP,
  type ActorContext,
  type ActorDef,
  type ActorIdentity,
  type ActorRef,
  type InternalActorHandle,
  type LifecycleEvent,
  type SupervisionStrategy,
} from './types.ts'

/**
 * Notification callback type — how a child notifies its parent of lifecycle events.
 */
export type ParentNotify = (event: LifecycleEvent) => void

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
  notifyParent: ParentNotify,
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

      // Child notifies this actor — transform child's own events into parent-perspective events
      const childIdentity: ActorIdentity = { name: fullName }
      const childNotify: ParentNotify = (event) => {
        switch (event.type) {
          case 'started':
            enqueueLifecycle({ type: 'child-started', child: childIdentity })
            break
          case 'stopped':
            enqueueLifecycle({ type: 'child-stopped', child: childIdentity })
            break
          case 'child-failed':
            // Propagate child failure to this actor's lifecycle handler
            enqueueLifecycle(event)
            break
          // Forward child-started/child-stopped from grandchildren as-is (bubbling)
          default:
            break
        }
      }

      const childHandle = createActor(fullName, childDef, childInitialState, childNotify)
      children.set(fullName, childHandle as InternalActorHandle)

      return childHandle.ref
    },

    stop: (child: ActorIdentity) => {
      const childHandle = children.get(child.name)
      if (childHandle) {
        children.delete(child.name)
        // Stop is async but we fire-and-forget here.
        // The child-stopped notification will arrive through childNotify.
        childHandle.stop()
      }
    },
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

  // ─── The async processing loop ───
  const runningPromise = (async () => {
    let state = initialState

    // Setup phase
    if (def.setup) {
      state = await def.setup(state, context)
    }

    // Notify parent that this actor has started
    notifyParent({ type: 'started' })

    // Message processing loop
    while (true) {
      const envelope = await mailbox.take()

      // Mailbox closed — exit the loop
      if (envelope === STOP) break

      try {
        if (envelope.tag === 'message') {
          const result = await def.handler(state, envelope.payload, context)
          state = result.state
        } else if (envelope.tag === 'lifecycle') {
          if (def.lifecycle) {
            const result = await def.lifecycle(state, envelope.event, context)
            state = result.state
          }
        }
      } catch (error: unknown) {
        // ─── Supervision: apply strategy on failure ───
        const selfIdentity: ActorIdentity = { name }

        switch (strategy.type) {
          case 'restart': {
            if (canRestart()) {
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
            // Retries exhausted — fall through to escalate/stop
            notifyParent({ type: 'child-failed', child: selfIdentity, error })
            break
          }

          case 'escalate': {
            // Notify parent of the failure
            notifyParent({ type: 'child-failed', child: selfIdentity, error })
            break
          }

          case 'stop':
          default: {
            // Default: silently stop the actor
            // Parent receives 'child-stopped' through the normal stop path
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

    // 3. Fire the 'stopped' lifecycle event
    if (def.lifecycle) {
      const result = await def.lifecycle(state, { type: 'stopped' }, context)
      state = result.state
    }

    // 4. Notify parent that this actor has stopped
    notifyParent({ type: 'stopped' })
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
