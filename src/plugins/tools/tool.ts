import type { ActorRef } from '../../system/types.ts'
import { createTopic } from '../../system/types.ts'

export type { ActorRef }

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
}

export type ToolReply =
  | { type: 'toolResult'; result: string; sources?: ToolSource[] }
  | { type: 'toolError'; error: string }

// ─── Registry types ───

export type ToolEntry = { schema: ToolSchema; ref: ActorRef<ToolInvokeMsg> }
export type ToolCollection = Record<string, ToolEntry>

export type ToolRegistrationEvent =
  | { name: string; schema: ToolSchema; ref: ActorRef<ToolInvokeMsg> }
  | { name: string; ref: null }

export const ToolRegistrationTopic = createTopic<ToolRegistrationEvent>('tools/registration')
