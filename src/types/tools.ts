import type { ActorRef } from '../system/index.ts'
import { createTopic } from '../system/index.ts'
import type { MessageAttachment } from './events.ts'

// ─── Schema (what the LLM sees) ───

export type ToolSchema = {
  type: 'function'
  function: { name: string; description: string; parameters: object }
}

export type ToolFilter = { allow: string[] } | { deny: string[] }

// ─── Generic tool protocol ───

export type ToolSource = { title: string; url: string; snippet: string }

export type ToolResultPayload = {
  text:         string
  sources?:     ToolSource[]
  attachments?: MessageAttachment[]
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

/** Terminal tool replies; `toolPending` is a lifecycle event, not a result. */
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

export type JobLifecycleEvent =
  | {
      jobId: string
      status: 'running'
      toolName: string
      toolRef: ActorRef<ToolMsg>
      startedAt: number
	      clientId?: string
	      userId?: string
	      statusText?: string
	      progress?: { current: number; total: number }
	      metadata?: Record<string, unknown>
	    }
	  | { jobId: string; status: 'completed'; result: ToolResultPayload; statusText?: string; metadata?: Record<string, unknown> }
	  | { jobId: string; status: 'failed';    error: string; metadata?: Record<string, unknown> }
	  | { jobId: string; status: 'cleared' }

export const JobRegistryTopic = createTopic<JobLifecycleEvent>('tools.jobs')
