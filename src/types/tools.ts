import type { ActorRef } from '../system/types.ts'
import { createTopic } from '../system/types.ts'

// ─── Schema (what the LLM sees) ───

export type ToolSchema = {
  type: 'function'
  function: { name: string; description: string; parameters: object }
}

// ─── Generic tool protocol ───

export type ToolSource = { title: string; url: string; snippet: string }

export type ToolInvokeMsg = {
  type: 'invoke'
  toolName: string
  arguments: string  // raw JSON string from LLM
  replyTo: ActorRef<ToolReply>
  clientId?: string
  userId: string
}

/**
 * Status query for long-running tool jobs. A tool that previously replied to
 * `invoke` with `toolPending` MUST handle this message for the same jobId,
 * replying with one of: `toolPending` (still running), `toolResult` (done),
 * `toolError` (failed or unknown jobId).
 */
export type ToolJobStatusMsg = {
  type: 'jobStatus'
  jobId: string
  replyTo: ActorRef<ToolReply>
}

export type ToolMsg = ToolInvokeMsg | ToolJobStatusMsg

export type ToolReply =
  | { type: 'toolResult'; result: string; sources?: ToolSource[] }
  | { type: 'toolError'; error: string }
  | { type: 'toolPending'; jobId: string; placeholderText?: string; pollIntervalMs?: number }

/** Final tool reply variants — what callers see from `invokeTool`. No `toolPending`. */
export type ToolFinalReply =
  | { type: 'toolResult'; result: string; sources?: ToolSource[] }
  | { type: 'toolError'; error: string }

// ─── Registry types ───

export type ToolEntry = {
  schema: ToolSchema
  ref: ActorRef<ToolMsg>
  /** Tool MAY reply with toolPending. Agents that don't support background completion
   *  should filter these out of their LLM tool list. Default false. */
  mayBeLongRunning?: boolean
}
export type ToolCollection = Record<string, ToolEntry>

export type ToolRegistrationEvent =
  | { name: string; schema: ToolSchema; ref: ActorRef<ToolMsg>; mayBeLongRunning?: boolean }
  | { name: string; ref: null }

export const ToolRegistrationTopic = createTopic<ToolRegistrationEvent>('tools.registration')

// ─── Job registry (for long-running jobs) ───
//
// `invokeTool` publishes `running` when a tool returns `toolPending`, and
// `cleared` when the job's final reply arrives. The `tool_status` plugin
// subscribes to this topic so it can route status queries (or list active
// jobs) without each agent having to track jobs itself.

export type JobLifecycleEvent =
  | {
      jobId: string
      status: 'running'
      toolName: string
      toolRef: ActorRef<ToolMsg>
      startedAt: number
      clientId?: string
      userId?: string
    }
  | { jobId: string; status: 'cleared' }

export const JobRegistryTopic = createTopic<JobLifecycleEvent>('tools.jobs')

// ─── Tool filter ───

export type ToolFilter = { allow: string[] } | { deny: string[] }

export const applyToolFilter = (name: string, filter?: ToolFilter): boolean => {
  if (!filter) return true
  if ('allow' in filter) return filter.allow.includes(name)
  return !filter.deny.includes(name)
}
