import { ask } from './ask.ts'
import type { ActorContext, ActorRef, MessageHeaders } from './types.ts'
import { JobRegistryTopic } from '../types/tools.ts'
import type { ToolFinalReply, ToolMsg, ToolReply, ToolSchema, ToolFilter } from '../types/tools.ts'

export type InvokeToolArgs = {
  toolName:  string
  arguments: string
  clientId?: string
  userId:    string
}

export type InvokeToolOptions<M> = {
  /**
   * Called when a long-running job eventually completes. The returned message
   * is enqueued to the caller's actor inbox. If omitted, `toolPending` replies
   * are converted to `toolError` (graceful fallback for agents that don't
   * support background completion).
   */
  onCompletion?: (reply: ToolFinalReply) => M
  headers?: MessageHeaders
}

/**
 * Invoke a tool. Always resolves with a final reply (`toolResult` or
 * `toolError`).
 *
 * If the tool replies with `toolPending` and `onCompletion` is supplied:
 *   - this Promise resolves immediately with a placeholder `toolResult`
 *   - the job is registered on `JobRegistryTopic` (so `tool_status` can find it)
 *   - the caller subscribes to `JobRegistryTopic` for completion events
 *   - when the tool publishes `completed` or `failed`, the subscription
 *     delivers `onCompletion(finalReply)` to the caller's inbox and cleans up
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
  const { jobId, placeholderText } = firstReply

  if (!options?.onCompletion) {
    return {
      type: 'toolError',
      error: `Tool '${args.toolName}' returned a long-running jobId (${jobId}) but caller does not support background completion.`,
    }
  }

  const onCompletion = options.onCompletion

  ctx.publishRetained(JobRegistryTopic, jobId, {
    jobId,
    status: 'running',
    toolName: args.toolName,
    toolRef,
    startedAt: Date.now(),
    clientId: args.clientId,
    userId: args.userId,
  })

  // Subscribe for completion notification via the topic instead of polling.
  // The jobId doubles as the subscription identifier for precise unsubscribe.
  ctx.subscribe(JobRegistryTopic, (event) => {
    if (event.jobId !== jobId) return null
    if (event.status === 'completed') {
      ctx.unsubscribe(JobRegistryTopic, jobId)
      ctx.publishRetained(JobRegistryTopic, jobId, { jobId, status: 'cleared' })
      return onCompletion({ type: 'toolResult', result: event.result })
    }
    if (event.status === 'failed') {
      ctx.unsubscribe(JobRegistryTopic, jobId)
      ctx.publishRetained(JobRegistryTopic, jobId, { jobId, status: 'cleared' })
      return onCompletion({ type: 'toolError', error: event.error })
    }
    return null
  }, jobId)

  return {
    type: 'toolResult',
    result: { text: placeholderText ?? `Job started; result will be delivered when ready (jobId=${jobId}).` },
  }
}

// ─── Schema (what the LLM sees) ───

export const defineTool = (
  name: string,
  description: string,
  parameters: object,
): { name: string; schema: ToolSchema } => ({
  name,
  schema: {
    type: 'function',
    function: { name, description, parameters },
  },
})

// ─── Tool filtering and parsing ───

type ToolParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

export const parseToolArgs = <T>(
  rawArgs: string,
  extract: (parsed: Record<string, unknown>) => T | null,
  missingMsg = 'Missing required arguments',
): ToolParseResult<T> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArgs)
  } catch {
    return { ok: false, error: 'Invalid arguments: expected JSON object' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Invalid arguments: expected JSON object' }
  }
  const value = extract(parsed as Record<string, unknown>)
  if (value === null) return { ok: false, error: missingMsg }
  return { ok: true, value }
}

export const applyToolFilter = (name: string, filter?: ToolFilter): boolean => {
  if (!filter) return true
  if ('allow' in filter) return filter.allow.includes(name)
  return !filter.deny.includes(name)
}
