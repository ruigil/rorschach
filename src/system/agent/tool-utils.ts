import { ask } from '../actor/ask.ts'
import type { ActorContext, ActorRef } from '../actor/types.ts'
import { JobRegistryTopic } from '../../types/tools.ts'
import type { ToolMsg, ToolReply, ToolSchema, ToolFilter } from '../../types/tools.ts'
import { authorize } from '../permissions/evaluator.ts'
import { USER_NOT_AUTHORIZED, type PermissionContext } from '../permissions/types.ts'
import { encodeMessageRequest } from '../context/request.ts'

import type { SCRInvokeMsg, SCRReply } from '../../types/scr.ts'
import type { MessageAttachment } from '../../types/events.ts'

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
  toolRef: ActorRef<any>,
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

  const urn = args.toolName.startsWith('scr:') ? args.toolName : `scr:leaf:${args.toolName.replace(/_/g, '.')}`

  const firstReply = await ask<any, any>(
    toolRef,
    (replyTo) => ({
      type: 'invoke',
      urn,
      toolName: args.toolName,
      arguments: args.arguments,
      input: args.arguments,
      replyTo,
    }),
    undefined,
    ctx.request,
  )

  const rep = firstReply as any
  if (rep.type === 'result' || rep.type === 'toolResult') {
    if (rep.type === 'toolResult') {
      return rep as ToolReply
    }
    let result: { text: string; attachments?: MessageAttachment[] }
    const output = rep.output
    if (typeof output === 'string') {
      result = { text: output }
    } else if (output && typeof output === 'object' && 'text' in output) {
      result = {
        text: String((output as any).text),
        attachments: (output as any).attachments,
      }
    } else {
      result = { text: JSON.stringify(output) }
    }
    return { type: 'toolResult', result }
  }

  if (rep.type === 'error' || rep.type === 'toolError') {
    return { type: 'toolError', error: rep.error }
  }

  if (rep.type === 'pending' || rep.type === 'toolPending') {
    const jobId = rep.jobId
    const placeholderText = rep.placeholderText

    ctx.publishRetained(JobRegistryTopic, jobId, {
      jobId,
      status: 'running',
      toolName: args.toolName,
      toolRef,
      startedAt: Date.now(),
      userId: ctx.request.userId,
    })

    return { type: 'toolPending', jobId, placeholderText }
  }

  return firstReply as unknown as ToolReply
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
  rawArgs: unknown,
  extract: (parsed: Record<string, unknown>) => T | null,
  missingMsg = 'Missing required arguments',
): ToolParseResult<T> => {
  let parsed: unknown = rawArgs
  if (typeof rawArgs === 'string') {
    try {
      parsed = JSON.parse(rawArgs)
    } catch {
      return { ok: false, error: 'Invalid arguments: expected JSON object' }
    }
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
