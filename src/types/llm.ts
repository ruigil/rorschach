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
  | { type: 'input_audio'; input_audio: { data: string; format: string } }

export type ApiMessage =
  | { role: 'system';    content: string }
  | { role: 'user';      content: string | UserContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool';      content: string; tool_call_id: string }

export type Tool = {
  type: 'function'
  function: { name: string; description: string; parameters: object }
}

// ─── Embedding reply ───

export type EmbeddingReply =
  | { type: 'embeddingResult'; embedding: number[] }
  | { type: 'embeddingError';  error: string }

// ─── Reply types sent back to the chatbot actor ───

export type LlmProviderReply =
  | { type: 'llmChunk';          requestId: string; text: string }
  | { type: 'llmReasoningChunk'; requestId: string; text: string }
  | { type: 'llmDone';           requestId: string; usage: TokenUsage | null }
  | { type: 'llmToolCalls';      requestId: string; calls: Array<{ id: string; name: string; arguments: string }>; usage: TokenUsage | null }
  | { type: 'llmError';          requestId: string; error: unknown }
  | { type: 'llmImageChunk';     requestId: string; dataUrl: string }

// ─── Reply type for streamImage — used only by the vision actor ───

export type VisionProviderReply =
  | { type: 'llmChunk';      requestId: string; text: string }
  | { type: 'llmImageChunk'; requestId: string; dataUrl: string }
  | { type: 'llmDone';       requestId: string; usage: TokenUsage | null }
  | { type: 'llmError';      requestId: string; error: unknown }

// ─── Reply type for streamAudio — used only by the audio actor ───

export type AudioProviderReply =
  | { type: 'llmAudioChunk'; requestId: string; data: string }
  | { type: 'llmChunk';      requestId: string; text: string }
  | { type: 'llmDone';       requestId: string; usage: TokenUsage | null }
  | { type: 'llmError';      requestId: string; error: unknown }

// ─── Incoming messages ───

export type LlmProviderMsg =
  | { type: 'stream';            requestId: string; model: string; messages: ApiMessage[]; tools?: Tool[]; role: string; clientId?: string; replyTo: ActorRef<LlmProviderReply> }
  | { type: 'streamImage';       requestId: string; model: string; messages: ApiMessage[]; role: string; clientId?: string; replyTo: ActorRef<VisionProviderReply> }
  | { type: 'streamAudio';       requestId: string; model: string; messages: ApiMessage[]; voice?: string; role: string; clientId?: string; replyTo: ActorRef<AudioProviderReply> }
  | { type: 'embed';             requestId: string; model: string; text: string; replyTo: ActorRef<EmbeddingReply> }
  | { type: 'fetchModelInfo';    model: string; replyTo: ActorRef<ModelInfo | null> }
  | { type: 'fetchModels';       replyTo: ActorRef<string[]> }
  | { type: '_streamDone';       result: LlmProviderReply; model: string; role: string; clientId?: string; replyTo: ActorRef<LlmProviderReply> }
  | { type: '_streamImageDone';  result: VisionProviderReply; model: string; role: string; clientId?: string; replyTo: ActorRef<VisionProviderReply> }
  | { type: '_streamAudioDone';  result: AudioProviderReply; model: string; role: string; clientId?: string; replyTo: ActorRef<AudioProviderReply> }
  | { type: '_embedDone';        result: EmbeddingReply; replyTo: ActorRef<EmbeddingReply> }
  | { type: '_modelInfoDone';    info: ModelInfo | null; replyTo: ActorRef<ModelInfo | null> }
  | { type: '_modelsDone';       models: string[]; replyTo: ActorRef<string[]> }
  | { type: '_costReady';        model: string; role: string; clientId?: string; usage: TokenUsage; info: ModelInfo | null }

// ─── Retained topic: announces the live llm-provider ref to subscribers ───

export type LlmProviderEvent = { ref: ActorRef<LlmProviderMsg> | null }
export const LlmProviderTopic = createTopic<LlmProviderEvent>('cognitive.llm-provider')

// ─── Cost event: emitted by any actor that completes an LLM call ───

export type CostEvent = {
  timestamp: number
  /** Caller role: 'reasoning' | 'vision' | 'audio' | 'memory' | 'user-context' | 'notebook' */
  role: string
  model: string
  inputTokens: number
  outputTokens: number
  /** Cost in USD; null when model pricing is unavailable */
  cost: number | null
  /** Present for per-client usage; absent for background tasks */
  clientId?: string
}
export const CostTopic = createTopic<CostEvent>('system.costs')

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
  streamAudio(
    model: string,
    messages: ApiMessage[],
    voice: string,
    onChunk: (text: string) => void,
    onAudioChunk: (data: string) => void,
  ): Promise<AdapterStreamResult>
  embed(model: string, text: string): Promise<number[]>
  fetchModelInfo(model: string): Promise<ModelInfo | null>
  fetchModels(): Promise<string[]>
}

// ─── OpenRouter adapter options ───

export type OpenRouterAdapterOptions = {
  apiKey: string
  reasoning?: { enabled?: boolean; effort?: 'high' | 'medium' | 'low' | 'minimal' }
}
