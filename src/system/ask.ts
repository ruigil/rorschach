import type { ActorRef } from './types.ts'

/**
 * Ask pattern: sends a message to a target actor and awaits a single response.
 *
 * Creates a lightweight virtual ActorRef whose `send` resolves the returned Promise.
 * No temporary actor is spawned — zero overhead.
 *
 * The caller provides a messageFactory that receives a `replyTo` ref and returns
 * the message to send. The target actor is expected to call `replyTo.send(response)`.
 *
 * Late replies (after timeout) are silently dropped.
 */
export const ask = <Request, Response>(
  target: ActorRef<Request>,
  messageFactory: (replyTo: ActorRef<Response>) => Request,
  options?: { timeoutMs?: number },
): Promise<Response> => {
  return new Promise<Response>((resolve, reject) => {
    let settled = false

    const replyTo: ActorRef<Response> = {
      name: `ask:${target.name}:${Date.now()}`,
      send: (response: Response) => {
        if (!settled) {
          settled = true
          resolve(response)
        }
      },
    }

    if (options?.timeoutMs !== undefined) {
      setTimeout(() => {
        if (!settled) {
          settled = true
          reject(new Error(`Ask to "${target.name}" timed out after ${options.timeoutMs}ms`))
        }
      }, options.timeoutMs)
    }

    target.send(messageFactory(replyTo))
  })
}
