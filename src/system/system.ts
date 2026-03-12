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

  const rootNotify: ParentNotify = (event) => {
    if (onLifecycle) {
      onLifecycle(event)
    }
  }

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

    const childHandle = createActor(name, def, initialState, rootNotify)
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
