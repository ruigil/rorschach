import { createMailbox } from './mailbox.ts'
import {
  STOP,
  type ActorContext,
  type ActorDef,
  type ActorIdentity,
  type ActorRef,
  type InternalActorHandle,
  type LifecycleEvent,
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

  // ─── Build the context ───
  const context: ActorContext<M> = {
    self: ref,

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

      if (envelope.tag === 'message') {
        const result = await def.handler(state, envelope.payload, context)
        state = result.state
      } else if (envelope.tag === 'lifecycle') {
        if (def.lifecycle) {
          const result = await def.lifecycle(state, envelope.event, context)
          state = result.state
        }
      }
    }

    // ─── Stopping phase ───

    // 1. Stop all children (top-down) and wait for them
    const stopPromises = Array.from(children.values()).map((child) => child.stop())
    await Promise.all(stopPromises)
    children.clear()

    // 2. Fire the 'stopped' lifecycle event
    if (def.lifecycle) {
      const result = await def.lifecycle(state, { type: 'stopped' }, context)
      state = result.state
    }

    // 3. Notify parent that this actor has stopped
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
