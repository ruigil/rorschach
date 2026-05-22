import type { TimerKey, Timers } from './types.ts'

/**
 * Internal entry tracking a single active timer.
 */
type TimerEntry = {
  id: ReturnType<typeof setTimeout>
  type: 'single' | 'periodic'
}

/**
 * Creates a Timers instance scoped to an actor's lifecycle.
 *
 * Timer messages are delivered by calling `enqueue(message)`.
 * The caller is responsible for providing an enqueue function that
 * routes messages into the actor's mailbox.
 *
 * Calling `cancelAll()` clears every active timer — this is called
 * automatically by the actor on stop and restart.
 */
export const createTimers = <M>(
  enqueue: (message: M) => void,
): Timers<M> => {
  const active = new Map<TimerKey, TimerEntry>()

  const cancel = (key: TimerKey): void => {
    const entry = active.get(key)
    if (entry) {
      if (entry.type === 'single') {
        clearTimeout(entry.id)
      } else {
        clearInterval(entry.id)
      }
      active.delete(key)
    }
  }

  const cancelAll = (): void => {
    for (const [key] of active) {
      cancel(key)
    }
  }

  const startSingleTimer = (key: TimerKey, message: M, delayMs: number): void => {
    // Replace any existing timer with the same key
    cancel(key)

    const id = setTimeout(() => {
      active.delete(key)
      enqueue(message)
    }, delayMs)

    active.set(key, { id, type: 'single' })
  }

  const startPeriodicTimer = (key: TimerKey, message: M, intervalMs: number): void => {
    // Replace any existing timer with the same key
    cancel(key)

    const id = setInterval(() => {
      enqueue(message)
    }, intervalMs)

    active.set(key, { id, type: 'periodic' })
  }

  const isActive = (key: TimerKey): boolean => active.has(key)

  return {
    startSingleTimer,
    startPeriodicTimer,
    cancel,
    cancelAll,
    isActive,
  }
}
