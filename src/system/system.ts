import { createActor, type ParentNotify } from './actor.ts'
import type {
  ActorDef,
  ActorIdentity,
  ActorRef,
  ActorSystem,
  InternalActorHandle,
  LifecycleEvent,
} from './types.ts'

/**
 * Optional handler for system-level lifecycle events.
 * Receives events from top-level actors (started, stopped).
 */
export type SystemLifecycleHandler = (event: LifecycleEvent) => void

/**
 * Creates the root actor system.
 *
 * The system acts as the guardian/root — it can spawn top-level actors
 * and shut down the entire hierarchy.
 */
export const createActorSystem = (
  onLifecycle?: SystemLifecycleHandler,
): ActorSystem => {
  const children = new Map<string, InternalActorHandle>()
  let shuttingDown = false

  const spawn = <M, S>(
    name: string,
    def: ActorDef<M, S>,
    initialState: S,
  ): ActorRef<M> => {
    if (shuttingDown) {
      throw new Error('Cannot spawn actors: system is shutting down')
    }

    if (children.has(name)) {
      throw new Error(`Actor "${name}" already exists at the system level`)
    }

    // Per-actor notify so the system can identify which actor's events these are
    const actorNotify: ParentNotify = (event) => {
      if (event.type === 'child-failed') {
        // A top-level actor failed — forward to system lifecycle handler
        if (onLifecycle) {
          onLifecycle(event)
        }
        return
      }

      if (event.type === 'started') {
        if (onLifecycle) {
          onLifecycle({ type: 'child-started', child: { name } })
        }
        return
      }

      if (event.type === 'stopped') {
        // Actor has fully stopped — remove from registry
        children.delete(name)
        if (onLifecycle) {
          onLifecycle({ type: 'child-stopped', child: { name } })
        }
        return
      }

      // Forward any other events as-is
      if (onLifecycle) {
        onLifecycle(event)
      }
    }

    const childHandle = createActor(name, def, initialState, actorNotify)
    children.set(name, childHandle as InternalActorHandle)

    return childHandle.ref
  }

  const stop = (child: ActorIdentity): void => {
    const childHandle = children.get(child.name)
    if (childHandle) {
      children.delete(child.name)
      childHandle.stop()
    }
  }

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true

    const stopPromises = Array.from(children.values()).map((child) => child.stop())
    await Promise.all(stopPromises)
    children.clear()
  }

  return { spawn, stop, shutdown }
}
