import { createSubscriptionMap } from './subscriptions.ts'
import type { EventStream, EventTopic } from './types.ts'

/**
 * Creates the system-level EventStream (pub-sub bus).
 *
 * Built on `createSubscriptionMap` — the same forward/reverse map pattern
 * used by the WatchService.
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

  return { publish, subscribe, unsubscribe, cleanup }
}
