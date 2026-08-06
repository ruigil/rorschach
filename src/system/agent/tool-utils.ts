import { ask } from '../actor/ask.ts'
import type { ActorContext, ActorRef } from '../actor/types.ts'
import { JobRegistryTopic } from '../../types/tools.ts'
import type { ToolMsg, ToolReply, ToolSchema, ToolFilter } from '../../types/tools.ts'
import { authorize } from '../permissions/evaluator.ts'
import { USER_NOT_AUTHORIZED, type PermissionContext } from '../permissions/types.ts'
import { encodeMessageRequest } from '../context/request.ts'

export type InvokeToolArgs = {
  toolName:  string
  arguments: string
}

/**
 * Invoke a tool and return its immediate reply.
 *
 * If the tool replies with `toolPending`:
 *   - this Promise resolves immediately with `toolPending`
 *   - the job is registered on `JobRegistryTopic`
 *   - the owner handles completion/failure from later job lifecycle events.
 */
export const invokeTool = async <M = any>(
  ctx: ActorContext<M>,
  toolRef: ActorRef<ToolMsg>,
  args: InvokeToolArgs,
): Promise<ToolReply> => {
  const perm = ctx.request.permission
  if (perm && !authorize(perm, args.toolName)) {
    ctx.log.warn('tool authorization denied', {
      event: 'permission_denied',
      userId: ctx.request.userId,
      toolName: args.toolName,
      surface: 'agent_loop',
      reason: 'missing_grant',
    })
    return { type: 'toolError', error: USER_NOT_AUTHORIZED }
  }

  const firstReply = await ask<ToolMsg, ToolReply>(
    toolRef,
    (replyTo) => ({
      type: 'invoke',
      toolName: args.toolName,
      arguments: args.arguments,
      replyTo,
    }),
    undefined,
    ctx.request,
  )

  if (firstReply.type === 'toolResult' || firstReply.type === 'toolError') {
    return firstReply
  }

  const { jobId } = firstReply

  ctx.publishRetained(JobRegistryTopic, jobId, {
    jobId,
    status: 'running',
    toolName: args.toolName,
    toolRef,
    startedAt: Date.now(),
    userId: ctx.request.userId,
  })

  return firstReply
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
