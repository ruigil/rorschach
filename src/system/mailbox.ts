import { STOP, type Mailbox, type Stop } from './types.ts'

/**
 * Creates an async FIFO mailbox with Promise-based wake mechanism.
 *
 * - `enqueue(item)` adds a message. If the consumer is suspended on `take()`,
 *   it is immediately woken up with the message.
 * - `take()` returns the next message, or suspends until one arrives.
 *   Returns `STOP` when the mailbox is closed.
 * - `close()` signals the consumer to exit. Any messages enqueued after close
 *   are silently dropped.
 */
export const createMailbox = <T>(): Mailbox<T> => {
  const queue: (T | Stop)[] = []
  let waiter: ((item: T | Stop) => void) | null = null
  let closed = false

  const enqueue = (item: T): void => {
    if (closed) return

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

  const take = (): Promise<T | Stop> => {
    // Messages already buffered — return the next one immediately
    if (queue.length > 0) {
      return Promise.resolve(queue.shift()!)
    }

    // Mailbox closed and empty — signal stop
    if (closed) {
      return Promise.resolve(STOP)
    }

    // Nothing in queue — suspend until enqueue() or close() is called
    return new Promise<T | Stop>((resolve) => {
      waiter = resolve
    })
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

  return { enqueue, take, close }
}
