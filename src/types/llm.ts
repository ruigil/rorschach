import { createTopic } from '../system/types.ts'
import type { ActorRef } from '../system/types.ts'

// ─── Shared types ───

export type TokenUsage = { promptTokens: number; completionTokens: number }

export type ModelInfo = { contextWindow: number; promptPer1M: number; completionPer1M: number }

export type ToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type UserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type ApiMessage =
  | { role: 'system';    content: string }
  | { role: 'user';      content: string | UserContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool';      content: string; tool_call_id: string }

export type Tool = {
  type: 'function'
  function: { name: string; description: string; parameters: object }
}

// ─── Reply types sent back to the ReAct loop ───

export type LlmProviderReply =
  | { type: 'llmChunk';          requestId: string; text: string }
  | { type: 'llmReasoningChunk'; requestId: string; text: string }
  | { type: 'llmDone';           requestId: string; usage: TokenUsage | null }
  | { type: 'llmToolCalls';      requestId: string; calls: Array<{ id: string; name: string; arguments: string }>; usage: TokenUsage | null }
  | { type: 'llmError';          requestId: string; error: unknown }
  | { type: 'llmImageChunk';     requestId: string; dataUrl: string }

// ─── Incoming messages ───

export type LlmProviderMsg =
  | { type: 'stream';           requestId: string; model: string; messages: ApiMessage[]; tools?: Tool[]; replyTo: ActorRef<LlmProviderReply> }
  | { type: 'streamImage';      requestId: string; model: string; messages: ApiMessage[]; replyTo: ActorRef<LlmProviderReply> }
  | { type: 'fetchModelInfo';   model: string; replyTo: ActorRef<ModelInfo | null> }
  | { type: 'fetchModels';      replyTo: ActorRef<string[]> }
  | { type: '_streamDone';      result: LlmProviderReply; replyTo: ActorRef<LlmProviderReply> }
  | { type: '_streamImageDone'; result: LlmProviderReply; replyTo: ActorRef<LlmProviderReply> }
  | { type: '_modelInfoDone';   info: ModelInfo | null; replyTo: ActorRef<ModelInfo | null> }
  | { type: '_modelsDone';      models: string[]; replyTo: ActorRef<string[]> }

// ─── Retained topic: announces the live llm-provider ref to subscribers ───

export type LlmProviderEvent = { ref: ActorRef<LlmProviderMsg> | null }
export const LlmProviderTopic = createTopic<LlmProviderEvent>('cognitive.llm-provider')

// ─── Adapter interface ───

type AdapterStreamResult =
  | { type: 'content';   usage: TokenUsage | null }
  | { type: 'toolCalls'; calls: Array<{ id: string; name: string; arguments: string }>; usage: TokenUsage | null }

export type LlmProviderAdapter = {
  stream(
    model: string,
    messages: ApiMessage[],
    tools: Tool[] | undefined,
    onChunk: (text: string) => void,
    onReasoningChunk: (text: string) => void,
  ): Promise<AdapterStreamResult>
  streamImage(
    model: string,
    messages: ApiMessage[],
    onChunk: (text: string) => void,
    onImageChunk: (dataUrl: string) => void,
  ): Promise<AdapterStreamResult>
  fetchModelInfo(model: string): Promise<ModelInfo | null>
  fetchModels(): Promise<string[]>
}

// ─── OpenRouter adapter options ───

export type OpenRouterAdapterOptions = {
  apiKey: string
  reasoning?: { enabled?: boolean; effort?: 'high' | 'medium' | 'low' | 'minimal' }
}
