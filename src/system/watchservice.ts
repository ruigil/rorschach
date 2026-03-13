import { createSubscriptionMap } from './subscriptions.ts'
import type { LifecycleEvent, WatchService } from './types.ts'

/**
 * Creates the WatchService: manages watcher subscriptions and notifications.
 *
 * Built on `createSubscriptionMap` — the same forward/reverse map pattern
 * used by the EventStream.
 *
 * Forward map: watched actor → Set of watchers
 * Reverse map: watcher → Set of watched actors
 */
export const createWatchService = (): WatchService => {
  const subs = createSubscriptionMap<LifecycleEvent>()

  const watch = (
    watcherName: string,
    targetName: string,
    notify: (event: LifecycleEvent) => void,
  ): void => {
    subs.add(watcherName, targetName, notify)
  }

  const unwatch = (watcherName: string, targetName: string): void => {
    subs.remove(watcherName, targetName)
  }

  const cleanup = (actorName: string): void => {
    // Remove all watches held BY this actor
    subs.cleanup(actorName)
    // Also remove any watchers OF this actor (forward map entry)
    // Handles the case where the actor dies and we've already notified watchers
    subs.deleteTopic(actorName)
  }

  const notifyWatchers = (actorName: string, reason: 'stopped' | 'failed', error?: unknown): void => {
    const event: LifecycleEvent = {
      type: 'terminated',
      ref: { name: actorName },
      reason,
      ...(error !== undefined ? { error } : {}),
    }
    subs.notify(actorName, event)
  }

  return { watch, unwatch, cleanup, notifyWatchers }
}
