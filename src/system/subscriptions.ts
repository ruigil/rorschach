/**
 * Generic forward/reverse subscription map.
 *
 * Models the pattern: "subscriber S is interested in topic T, and should
 * be notified via callback C."
 *
 * The EventStream uses this for all pub-sub, including:
 *   - Domain events: arbitrary string topics
 *   - Actor lifecycle watches: `$watch:<actorName>` topics
 *
 * Forward map:  topic → Set<{ name, callback }>
 * Reverse map:  name  → Set<topics>
 *
 * The reverse map enables O(1) cleanup when a subscriber dies.
 */
export type SubscriptionMap<V> = {
  /** Add a subscription. Idempotent: duplicate (name, topic) pairs are ignored. */
  readonly add: (name: string, topic: string, callback: (value: V) => void) => void
  /** Remove a single subscription. */
  readonly remove: (name: string, topic: string) => void
  /** Remove all subscriptions held BY this name. */
  readonly cleanup: (name: string) => void
  /** Invoke all callbacks registered for the given topic. */
  readonly notify: (topic: string, value: V) => void
  /** Remove the forward-map entry for a topic entirely (used when a watched actor dies). */
  readonly deleteTopic: (topic: string) => void
}

export const createSubscriptionMap = <V>(): SubscriptionMap<V> => {
  // topic → Set of { name, callback }
  const forward = new Map<string, Set<{ name: string; callback: (value: V) => void }>>()
  // name → Set of topics
  const reverse = new Map<string, Set<string>>()

  const add = (name: string, topic: string, callback: (value: V) => void): void => {
    let entries = forward.get(topic)
    if (!entries) {
      entries = new Set()
      forward.set(topic, entries)
    }

    // Idempotent: check if already subscribed
    for (const entry of entries) {
      if (entry.name === name) return
    }
    entries.add({ name, callback })

    // Reverse map
    let topics = reverse.get(name)
    if (!topics) {
      topics = new Set()
      reverse.set(name, topics)
    }
    topics.add(topic)
  }

  const remove = (name: string, topic: string): void => {
    const entries = forward.get(topic)
    if (entries) {
      for (const entry of entries) {
        if (entry.name === name) {
          entries.delete(entry)
          break
        }
      }
      if (entries.size === 0) forward.delete(topic)
    }

    const topics = reverse.get(name)
    if (topics) {
      topics.delete(topic)
      if (topics.size === 0) reverse.delete(name)
    }
  }

  const cleanup = (name: string): void => {
    const topics = reverse.get(name)
    if (topics) {
      for (const topic of topics) {
        const entries = forward.get(topic)
        if (entries) {
          for (const entry of entries) {
            if (entry.name === name) {
              entries.delete(entry)
              break
            }
          }
          if (entries.size === 0) forward.delete(topic)
        }
      }
      reverse.delete(name)
    }
  }

  const notify = (topic: string, value: V): void => {
    const entries = forward.get(topic)
    if (entries) {
      for (const { callback } of entries) {
        callback(value)
      }
    }
  }

  const deleteTopic = (topic: string): void => {
    forward.delete(topic)
  }

  return { add, remove, cleanup, notify, deleteTopic }
}
