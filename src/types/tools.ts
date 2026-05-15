import type { ActorRef } from '../system/types.ts'
import { createTopic } from '../system/types.ts'

// ─── Schema (what the LLM sees) ───

export type ToolSchema = {
  type: 'function'
  function: { name: string; description: string; parameters: object }
}

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

// ─── Generic tool protocol ───

export type ToolSource = { title: string; url: string; snippet: string }

export type ToolAttachment =
  | { kind: 'image'; url: string; alt?: string; mimeType?: string }
  | { kind: 'audio'; url: string; alt?: string; mimeType?: string }
  | { kind: 'video'; url: string; alt?: string; mimeType?: string }
  | { kind: 'file';  url: string; alt?: string; mimeType?: string }

export type ToolResultPayload = {
  text:         string
  sources?:     ToolSource[]
  attachments?: ToolAttachment[]
}

export type ToolInvokeMsg = {
  type: 'invoke'
  toolName: string
  arguments: string  // raw JSON string from LLM
  replyTo: ActorRef<ToolReply>
  clientId?: string
  userId: string
}

export type ToolMsg = ToolInvokeMsg

export type ToolReply =
  | { type: 'toolResult'; result: ToolResultPayload }
  | { type: 'toolError'; error: string }
  | { type: 'toolPending'; jobId: string; placeholderText?: string }

/** Final tool reply variants — what callers see from `invokeTool`. */
export type ToolFinalReply =
  | { type: 'toolResult'; result: ToolResultPayload }
  | { type: 'toolError'; error: string }

// ─── Registry types ───

export type Tool = {
  name: string
  schema: ToolSchema
  ref: ActorRef<ToolMsg>
  /** Tool MAY reply with toolPending. Agents that don't support background completion
   *  should filter these out of their LLM tool list. Default false. */
  mayBeLongRunning?: boolean
}
export type ToolCollection = Record<string, Tool>

export type ToolRegistrationEvent =
  | Tool
  | { name: string; ref: null }

export const ToolRegistrationTopic = createTopic<ToolRegistrationEvent>('tools.registration')

// ─── Job registry (for long-running jobs) ───
//
// `invokeTool` publishes `running` when a tool returns `toolPending`.
// Tools publish `completed` or `failed` when their work finishes.
// `invokeTool`'s subscriber catches these and publishes `cleared`
// to remove the retained entry. The `tool_status` plugin subscribes
// to this topic so it can route status queries without polling tools.

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
  | { jobId: string; status: 'completed'; result: ToolResultPayload }
  | { jobId: string; status: 'failed';    error: string }
  | { jobId: string; status: 'cleared' }

export const JobRegistryTopic = createTopic<JobLifecycleEvent>('tools.jobs')

// ─── Tool filter ───

export type ToolParseResult<T> =
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

export type ToolFilter = { allow: string[] } | { deny: string[] }

export const applyToolFilter = (name: string, filter?: ToolFilter): boolean => {
  if (!filter) return true
  if ('allow' in filter) return filter.allow.includes(name)
  return !filter.deny.includes(name)
}
