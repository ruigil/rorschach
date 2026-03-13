import type { EventStream, EventTopic } from './types.ts'

/**
 * Creates the system-level EventStream (pub-sub bus).
 *
 * Structurally mirrors the WatchService pattern: forward map (topic → subscribers),
 * reverse map (subscriber → topics), idempotent subscribe, cleanup on actor death.
 *
 * Events are delivered synchronously into each subscriber's deliver callback,
 * which typically enqueues into the subscriber's mailbox — preserving the
 * single-message-at-a-time processing guarantee.
 */
export const createEventStream = (): EventStream => {
  // topic → Set of { subscriberName, deliver }
  const subscribers = new Map<
    EventTopic,
    Set<{ subscriberName: string; deliver: (event: unknown) => void }>
  >()
  // subscriberName → Set of topics (reverse index for cleanup)
  const subscribedBy = new Map<string, Set<EventTopic>>()

  const publish = (topic: EventTopic, event: unknown): void => {
    const subs = subscribers.get(topic)
    if (subs) {
      for (const { deliver } of subs) {
        deliver(event)
      }
    }
  }

  const subscribe = (
    subscriberName: string,
    topic: EventTopic,
    deliver: (event: unknown) => void,
  ): void => {
    let topicSubs = subscribers.get(topic)
    if (!topicSubs) {
      topicSubs = new Set()
      subscribers.set(topic, topicSubs)
    }
    // Idempotent: check if already subscribed
    for (const entry of topicSubs) {
      if (entry.subscriberName === subscriberName) return
    }
    topicSubs.add({ subscriberName, deliver })

    // Reverse map
    let topics = subscribedBy.get(subscriberName)
    if (!topics) {
      topics = new Set()
      subscribedBy.set(subscriberName, topics)
    }
    topics.add(topic)
  }

  const unsubscribe = (subscriberName: string, topic: EventTopic): void => {
    const topicSubs = subscribers.get(topic)
    if (topicSubs) {
      for (const entry of topicSubs) {
        if (entry.subscriberName === subscriberName) {
          topicSubs.delete(entry)
          break
        }
      }
      if (topicSubs.size === 0) subscribers.delete(topic)
    }

    const topics = subscribedBy.get(subscriberName)
    if (topics) {
      topics.delete(topic)
      if (topics.size === 0) subscribedBy.delete(subscriberName)
    }
  }

  const cleanup = (subscriberName: string): void => {
    const topics = subscribedBy.get(subscriberName)
    if (topics) {
      for (const topic of topics) {
        const topicSubs = subscribers.get(topic)
        if (topicSubs) {
          for (const entry of topicSubs) {
            if (entry.subscriberName === subscriberName) {
              topicSubs.delete(entry)
              break
            }
          }
          if (topicSubs.size === 0) subscribers.delete(topic)
        }
      }
      subscribedBy.delete(subscriberName)
    }
  }

  return { publish, subscribe, unsubscribe, cleanup }
}
