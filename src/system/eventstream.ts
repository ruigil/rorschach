import { createSubscriptionMap } from './subscriptions.ts'
import type { EventStream, EventTopic } from './types.ts'

/**
 * Topic convention for watch/lifecycle subscriptions.
 *
 * Watching an actor is just subscribing to its lifecycle topic on the
 * EventStream. The `$watch:` prefix separates lifecycle subscriptions
 * from domain-event subscriptions (which use the actor name directly).
 */
export const watchTopic = (actorName: string): EventTopic => `$watch:${actorName}`

/**
 * Creates the system-level EventStream (pub-sub bus).
 *
 * Built on `createSubscriptionMap` — a forward/reverse map that enables
 * O(1) cleanup when a subscriber dies.
 *
 * This single bus handles both domain events (arbitrary string topics)
 * and actor lifecycle watches (`$watch:<actorName>` topics). The
 * WatchService is no longer a separate module — watching is just
 * subscribing to a special topic.
 *
 * Events are delivered synchronously into each subscriber's deliver callback,
 * which typically enqueues into the subscriber's mailbox — preserving the
 * single-message-at-a-time processing guarantee.
 */
export const createEventStream = (): EventStream => {
  const subs = createSubscriptionMap<unknown>()

  const publish = (topic: EventTopic, event: unknown): void => {
    subs.notify(topic, event)
  }

  const subscribe = (
    subscriberName: string,
    topic: EventTopic,
    deliver: (event: unknown) => void,
  ): void => {
    subs.add(subscriberName, topic, deliver)
  }

  const unsubscribe = (subscriberName: string, topic: EventTopic): void => {
    subs.remove(subscriberName, topic)
  }

  const cleanup = (subscriberName: string): void => {
    subs.cleanup(subscriberName)
  }

  const deleteTopic = (topic: EventTopic): void => {
    subs.deleteTopic(topic)
  }

  return { publish, subscribe, unsubscribe, cleanup, deleteTopic }
}
