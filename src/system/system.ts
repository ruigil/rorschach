import { createActor } from './actor.ts'
import type {
  ActorDef,
  ActorIdentity,
  ActorRef,
  ActorServices,
  ActorSystem,
  InternalActorHandle,
  LifecycleEvent,
} from './types.ts'

/**
 * Optional handler for system-level lifecycle events.
 * Receives `terminated` events from watched top-level actors.
 */
export type SystemLifecycleHandler = (event: LifecycleEvent) => void

// ─── Registry: flat map of actor name → ActorRef ───

const createRegistry = () => {
  const actors = new Map<string, ActorRef<unknown>>()

  const register = (name: string, ref: ActorRef<unknown>): void => {
    actors.set(name, ref)
  }

  const unregister = (name: string): void => {
    actors.delete(name)
  }

  const lookup = <T = unknown>(name: string): ActorRef<T> | undefined => {
    return actors.get(name) as ActorRef<T> | undefined
  }

  return { register, unregister, lookup }
}

// ─── Watch Service: manages watcher subscriptions and notifications ───

const createWatchService = () => {
  // watched actor name → Set of { watcherName, notify callback }
  const watchers = new Map<string, Set<{ watcherName: string; notify: (event: LifecycleEvent) => void }>>()
  // watcher actor name → Set of watched actor names (reverse index for cleanup)
  const watchedBy = new Map<string, Set<string>>()

  const watch = (
    watcherName: string,
    targetName: string,
    notify: (event: LifecycleEvent) => void,
  ): void => {
    // Add to forward map: target → watchers
    let targetWatchers = watchers.get(targetName)
    if (!targetWatchers) {
      targetWatchers = new Set()
      watchers.set(targetName, targetWatchers)
    }
    // Idempotent: check if already watching
    for (const entry of targetWatchers) {
      if (entry.watcherName === watcherName) return
    }
    targetWatchers.add({ watcherName, notify })

    // Add to reverse map: watcher → targets
    let targets = watchedBy.get(watcherName)
    if (!targets) {
      targets = new Set()
      watchedBy.set(watcherName, targets)
    }
    targets.add(targetName)
  }

  const unwatch = (watcherName: string, targetName: string): void => {
    // Remove from forward map
    const targetWatchers = watchers.get(targetName)
    if (targetWatchers) {
      for (const entry of targetWatchers) {
        if (entry.watcherName === watcherName) {
          targetWatchers.delete(entry)
          break
        }
      }
      if (targetWatchers.size === 0) {
        watchers.delete(targetName)
      }
    }

    // Remove from reverse map
    const targets = watchedBy.get(watcherName)
    if (targets) {
      targets.delete(targetName)
      if (targets.size === 0) {
        watchedBy.delete(watcherName)
      }
    }
  }

  /**
   * Remove all watches held BY this actor.
   * Called when an actor stops, to prevent dangling watch entries.
   */
  const cleanup = (actorName: string): void => {
    const targets = watchedBy.get(actorName)
    if (targets) {
      for (const targetName of targets) {
        const targetWatchers = watchers.get(targetName)
        if (targetWatchers) {
          for (const entry of targetWatchers) {
            if (entry.watcherName === actorName) {
              targetWatchers.delete(entry)
              break
            }
          }
          if (targetWatchers.size === 0) {
            watchers.delete(targetName)
          }
        }
      }
      watchedBy.delete(actorName)
    }

    // Also clean up any watchers OF this actor (forward map entry)
    // This handles the case where the actor dies and we've already notified watchers
    watchers.delete(actorName)
  }

  /**
   * Notify all watchers that the given actor has terminated.
   */
  const notifyWatchers = (actorName: string, reason: 'stopped' | 'failed', error?: unknown): void => {
    const targetWatchers = watchers.get(actorName)
    if (targetWatchers) {
      const event: LifecycleEvent = {
        type: 'terminated',
        ref: { name: actorName },
        reason,
        ...(error !== undefined ? { error } : {}),
      }
      for (const { notify } of targetWatchers) {
        notify(event)
      }
    }
  }

  return { watch, unwatch, cleanup, notifyWatchers }
}

// ─── Actor System ───

/**
 * Creates the root actor system.
 *
 * The system acts as the guardian/root — it can spawn top-level actors
 * and shut down the entire hierarchy.
 *
 * Internally creates a shared registry and watch service that are
 * threaded through to every actor in the hierarchy.
 */
export const createActorSystem = (
  onLifecycle?: SystemLifecycleHandler,
): ActorSystem => {
  const children = new Map<string, InternalActorHandle>()
  let shuttingDown = false

  // Shared infrastructure
  const registry = createRegistry()
  const watchService = createWatchService()

  const services: ActorServices = {
    registry,
    watchService,
  }

  // Synthetic watcher name for system-level watches
  const SYSTEM_WATCHER = '__system__'

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

    const childHandle = createActor(name, def, initialState, services)
    children.set(name, childHandle as InternalActorHandle)

    // System watches top-level actors for lifecycle reporting
    if (onLifecycle) {
      watchService.watch(SYSTEM_WATCHER, name, (event) => {
        if (event.type === 'terminated') {
          children.delete(name)
        }
        onLifecycle(event)
      })
    } else {
      // Even without a lifecycle handler, clean up the children map on termination
      watchService.watch(SYSTEM_WATCHER, name, (event) => {
        if (event.type === 'terminated') {
          children.delete(name)
        }
      })
    }

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
