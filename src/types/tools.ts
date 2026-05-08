import type { ActorRef } from '../system/types.ts'
import { createTopic } from '../system/types.ts'

// ─── Schema (what the LLM sees) ───

export type ToolSchema = {
  type: 'function'
  function: { name: string; description: string; parameters: object }
}

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

/**
 * Render a ToolResultPayload as the string content for a `tool`-role LLM message.
 * Auto-appends a standardized attachments block so individual tools don't have to
 * coax the LLM with hand-written markdown like "Include this in your reply: ![...](url)".
 * Sources are NOT auto-appended — tools that have citations should inline grounding
 * snippets directly in `text` (see web-search).
 */
export const renderToolResultForLlm = (payload: ToolResultPayload): string => {
  if (!payload.attachments || payload.attachments.length === 0) return payload.text
  const lines = payload.attachments.map((a) => {
    const label = a.alt ? ` (${a.alt})` : ''
    return `- ${a.kind}: ${a.url}${label}`
  })
  const header = '[Attachments produced by this tool — reference these in your reply if relevant:]'
  return payload.text
    ? `${payload.text}\n\n${header}\n${lines.join('\n')}`
    : `${header}\n${lines.join('\n')}`
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

export type ToolFilter = { allow: string[] } | { deny: string[] }

export const applyToolFilter = (name: string, filter?: ToolFilter): boolean => {
  if (!filter) return true
  if ('allow' in filter) return filter.allow.includes(name)
  return !filter.deny.includes(name)
}
