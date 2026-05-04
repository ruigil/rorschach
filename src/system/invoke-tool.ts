import { ask } from './ask.ts'
import type { ActorContext, ActorRef, MessageHeaders } from './types.ts'
import { JobRegistryTopic } from '../types/tools.ts'
import type { ToolFinalReply, ToolMsg, ToolReply } from '../types/tools.ts'

export type InvokeToolArgs = {
  toolName:  string
  arguments: string
  clientId?: string
  userId:    string
}

export type InvokeToolOptions<M> = {
  /**
   * Called when a long-running job eventually completes. The returned message
   * is enqueued to the caller's actor inbox via `pipeToSelf`. If omitted,
   * `toolPending` replies are converted to `toolError` (graceful fallback for
   * agents that don't support background completion).
   */
  onCompletion?: (reply: ToolFinalReply) => M
  /** Default poll interval if the tool's `toolPending` reply doesn't supply one. */
  defaultPollIntervalMs?: number
  /** Per-poll `jobStatus` ask timeout (default 5000ms). */
  jobStatusTimeoutMs?: number
  headers?: MessageHeaders
}

/**
 * Invoke a tool. Always resolves with a final reply (`toolResult` or
 * `toolError`).
 *
 * If the tool replies with `toolPending` and `onCompletion` is supplied:
 *   - this Promise resolves immediately with a placeholder `toolResult`
 *   - the job is registered on `JobRegistryTopic` (so `tool_status` can find it)
 *   - polling continues in the background
 *   - when a final reply arrives, the job is cleared from the registry and
 *     `onCompletion(finalReply)` is delivered via `pipeToSelf`
 *
 * If `onCompletion` is omitted, a `toolPending` reply is converted to
 * `toolError` so the caller's existing error path runs.
 */
export const invokeTool = async <M>(
  ctx: ActorContext<M>,
  toolRef: ActorRef<ToolMsg>,
  args: InvokeToolArgs,
  options?: InvokeToolOptions<M>,
): Promise<ToolFinalReply> => {
  const firstReply = await ask<ToolMsg, ToolReply>(
    toolRef,
    (replyTo) => ({
      type: 'invoke',
      toolName: args.toolName,
      arguments: args.arguments,
      clientId: args.clientId,
      userId: args.userId,
      replyTo,
    }),
    undefined,
    options?.headers,
  )

  if (firstReply.type === 'toolResult' || firstReply.type === 'toolError') {
    return firstReply
  }

  // toolPending
  const { jobId, placeholderText, pollIntervalMs } = firstReply

  if (!options?.onCompletion) {
    return {
      type: 'toolError',
      error: `Tool '${args.toolName}' returned a long-running jobId (${jobId}) but caller does not support background completion.`,
    }
  }

  const onCompletion = options.onCompletion
  const askTimeout = options.jobStatusTimeoutMs ?? 5000
  const startInterval = pollIntervalMs ?? options.defaultPollIntervalMs ?? 5000

  ctx.publishRetained(JobRegistryTopic, jobId, {
    jobId,
    status: 'running',
    toolName: args.toolName,
    toolRef,
    startedAt: Date.now(),
    clientId: args.clientId,
    userId: args.userId,
  })

  const finalPromise = (async (): Promise<ToolFinalReply> => {
    let currentInterval = startInterval
    while (true) {
      await new Promise<void>(r => setTimeout(r, currentInterval))
      let reply: ToolReply
      try {
        reply = await ask<ToolMsg, ToolReply>(
          toolRef,
          (replyTo) => ({ type: 'jobStatus', jobId, replyTo }),
          { timeoutMs: askTimeout },
          options.headers,
        )
      } catch {
        // ask timeout — retry on next interval
        continue
      }
      if (reply.type === 'toolPending') {
        currentInterval = reply.pollIntervalMs ?? currentInterval
        continue
      }
      return reply
    }
  })()

  ctx.pipeToSelf(
    finalPromise,
    (finalReply) => {
      ctx.publishRetained(JobRegistryTopic, jobId, { jobId, status: 'cleared' })
      return onCompletion(finalReply)
    },
    (err) => {
      ctx.publishRetained(JobRegistryTopic, jobId, { jobId, status: 'cleared' })
      return onCompletion({ type: 'toolError', error: String(err) })
    },
  )

  return {
    type: 'toolResult',
    result: placeholderText ?? `Job started; result will be delivered when ready (jobId=${jobId}).`,
  }
}
