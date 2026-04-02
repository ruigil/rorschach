import type { ActorRef } from '../system/types.ts'
import type { LlmProviderMsg, LlmProviderReply } from './llm.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from './tools.ts'

// ─── ReAct loop message protocol ───

export type ReActMsg =
  | { type: 'userMessage'; text: string; images?: string[]; audio?: string; traceId: string; parentSpanId: string }
  | LlmProviderReply
  | { type: '_toolRegistered';      name: string; schema: ToolSchema; ref: ActorRef<ToolInvokeMsg> }
  | { type: '_toolUnregistered';    name: string }
  | { type: '_toolResult';          toolName: string; toolCallId: string; reply: ToolReply }
  | { type: '_llmProviderUpdated';  ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_userContext';         summary: string }
