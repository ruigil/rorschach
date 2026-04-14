import type { ActorRef } from '../system/types.ts'
import type { LlmProviderMsg, LlmProviderReply } from './llm.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from './tools.ts'

// ─── Chatbot actor message protocol ───

export type ChatbotMsg =
  | { type: 'userMessage'; clientId: string; text: string; images?: string[]; audio?: string; pdfs?: string[]; traceId: string; parentSpanId: string; isCron?: boolean }
  | LlmProviderReply
  | { type: '_toolRegistered';      name: string; schema: ToolSchema; ref: ActorRef<ToolInvokeMsg> }
  | { type: '_toolUnregistered';    name: string }
  | { type: '_toolResult';          toolName: string; toolCallId: string; reply: ToolReply }
  | { type: '_llmProviderUpdated';  ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_userContext';         summary: string }
