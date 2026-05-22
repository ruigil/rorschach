import { STOP, type Mailbox, type MailboxConfig, type Stop } from './types.ts'

/**
 * Creates an async FIFO mailbox with Promise-based wake mechanism.
 *
 * - `enqueue(item)` adds a message. If the consumer is suspended on `take()`,
 *   it is immediately woken up with the message. Respects capacity limits
 *   when a `MailboxConfig` with `capacity` is provided.
 * - `enqueueSystem(item)` adds a message bypassing capacity limits. Used for
 *   lifecycle/control events that must never be dropped.
 * - `take()` returns the next message, or suspends until one arrives.
 *   Returns `STOP` when the mailbox is closed.
 * - `close()` signals the consumer to exit. Any messages enqueued after close
 *   are silently dropped.
 * - `size` returns the current number of items in the queue.
 *
 * When `capacity` is set and the queue is full:
 * - `'drop-newest'` (default): the incoming message is dropped.
 * - `'drop-oldest'`: the oldest message in the queue is dropped to make room.
 *
 * In both cases, the `onOverflow` callback is invoked with the dropped item.
 */
export const createMailbox = <T>(config?: MailboxConfig): Mailbox<T> => {
  const queue: (T | Stop)[] = []
  let waiter: ((item: T | Stop) => void) | null = null
  let closed = false
  let draining = false

  const capacity = config?.capacity
  const strategy = config?.overflowStrategy ?? 'drop-newest'
  const onOverflow = config?.onOverflow

  const deliverOrBuffer = (item: T | Stop): void => {
    if (waiter !== null) {
      // Consumer is suspended on take() — deliver immediately
      const resolve = waiter
      waiter = null
      resolve(item)
    } else {
      // No consumer waiting — buffer the message
      queue.push(item)
    }
  }

  const enqueue = (item: T): void => {
    if (closed || draining) return

    if (waiter !== null) {
      // Consumer is suspended — deliver immediately (no queue growth)
      const resolve = waiter
      waiter = null
      resolve(item)
      return
    }

    // ─── Bounded check (only when buffering) ───
    if (capacity !== undefined && queue.length >= capacity) {
      if (strategy === 'drop-newest') {
        // Drop the incoming message
        onOverflow?.(item)
        return
      }
      if (strategy === 'drop-oldest') {
        // Drop the oldest message from the front to make room
        const dropped = queue.shift()
        onOverflow?.(dropped)
      }
    }

    queue.push(item)
  }

  const enqueueSystem = (item: T): void => {
    if (closed) return
    deliverOrBuffer(item)
  }

  const take = (): Promise<T | Stop> => {
    // Messages already buffered — return the next one immediately
    if (queue.length > 0) {
      return Promise.resolve(queue.shift()!)
    }

    // Mailbox closed and empty — signal stop
    if (closed) {
      return Promise.resolve(STOP)
    }

    // Draining and queue empty — all buffered messages processed, signal stop
    if (draining) {
      return Promise.resolve(STOP)
    }

    // Nothing in queue — suspend until enqueue() or close() is called
    return new Promise<T | Stop>((resolve) => {
      waiter = resolve
    })
  }

  const drain = (): void => {
    if (closed || draining) return
    draining = true

    // If consumer is suspended and queue is empty, all messages are already
    // processed — wake immediately with STOP.
    if (waiter !== null && queue.length === 0) {
      const resolve = waiter
      waiter = null
      resolve(STOP)
    }
    // Otherwise the consumer is busy processing. When it next calls take()
    // and finds an empty queue + draining=true, it will receive STOP.
  }

  const close = (): void => {
    if (closed) return
    closed = true

    if (waiter !== null) {
      // Consumer is suspended — wake it up with STOP
      const resolve = waiter
      waiter = null
      resolve(STOP)
    } else {
      // Consumer is busy processing — enqueue STOP so it sees it next
      queue.push(STOP)
    }
  }

  return {
    enqueue,
    enqueueSystem,
    take,
    close,
    drain,
    size: () => queue.length,
  }
}
