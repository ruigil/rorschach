import type { EventStream, EventTopic, LifecycleEvent, ActorRef, Registry } from './types.ts'

/**
 * Topic convention for watch/lifecycle subscriptions.
 *
 * Watching an actor is just subscribing to its lifecycle topic on the
 * EventStream. The `$watch:` prefix separates lifecycle subscriptions
 * from domain-event subscriptions (which use the actor name directly).
 */
export const watchTopic = (actorName: string): EventTopic<LifecycleEvent> =>
  `$watch:${actorName}` as EventTopic<LifecycleEvent>

/**
 * Creates the system-level EventStream (pub-sub bus).
 *
 * Uses a forward/reverse map internally:
 *   Forward:  topic → Set<{ name, callback }>
 *   Reverse:  name  → Set<topics>
 *
 * The reverse map enables O(1) cleanup when a subscriber dies.
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
  // topic → Set of { name, callback }
  const forward = new Map<string, Set<{ name: string; callback: (value: unknown) => void }>>()
  // name → Set of topics
  const reverse = new Map<string, Set<string>>()

  const publish = (topic: EventTopic, event: unknown): void => {
    const entries = forward.get(topic)
    if (entries) {
      for (const { callback } of entries) {
        callback(event)
      }
    }
  }

  const subscribe = (
    subscriberName: string,
    topic: EventTopic,
    deliver: (event: unknown) => void,
  ): void => {
    let entries = forward.get(topic)
    if (!entries) {
      entries = new Set()
      forward.set(topic, entries)
    }

    // Idempotent: check if already subscribed
    for (const entry of entries) {
      if (entry.name === subscriberName) return
    }
    entries.add({ name: subscriberName, callback: deliver })

    // Reverse map
    let topics = reverse.get(subscriberName)
    if (!topics) {
      topics = new Set()
      reverse.set(subscriberName, topics)
    }
    topics.add(topic)
  }

  const unsubscribe = (subscriberName: string, topic: EventTopic): void => {
    const entries = forward.get(topic)
    if (entries) {
      for (const entry of entries) {
        if (entry.name === subscriberName) {
          entries.delete(entry)
          break
        }
      }
      if (entries.size === 0) forward.delete(topic)
    }

    const topics = reverse.get(subscriberName)
    if (topics) {
      topics.delete(topic)
      if (topics.size === 0) reverse.delete(subscriberName)
    }
  }

  const cleanup = (subscriberName: string): void => {
    const topics = reverse.get(subscriberName)
    if (topics) {
      for (const topic of topics) {
        const entries = forward.get(topic)
        if (entries) {
          for (const entry of entries) {
            if (entry.name === subscriberName) {
              entries.delete(entry)
              break
            }
          }
          if (entries.size === 0) forward.delete(topic)
        }
      }
      reverse.delete(subscriberName)
    }
  }

  const deleteTopic = (topic: EventTopic): void => {
    forward.delete(topic)
  }

  const snapshot = () => {
    const result: { topic: string; subscribers: string[] }[] = []
    for (const [topic, entries] of forward) {
      result.push({ topic, subscribers: Array.from(entries).map(e => e.name).sort() })
    }
    result.sort((a, b) => a.topic.localeCompare(b.topic))
    return result
  }

  // The internal implementation stores `unknown` callbacks — the phantom type
  // on EventTopic<T> provides compile-time safety at call sites. The cast here
  // bridges the runtime (untyped) implementation to the typed public interface.
  return { publish, subscribe, unsubscribe, cleanup, deleteTopic, snapshot } as EventStream
}

/**
 * Creates the actor registry: a flat map of actor name → ActorRef.
 *
 * Every actor registers itself after setup completes and unregisters on stop.
 * Used by `context.lookup()` to find actors by name.
 */
export const createRegistry = (): Registry => {
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
