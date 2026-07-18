import { createTopic } from '../system/index.ts'
import type { ActorRef } from '../system/index.ts'
import type { PersistenceMsg } from './persistence.ts'

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

export type LlmTool = {
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

// ─── Reply type for transcribe — used only by the audio actor ───

export type TranscriptionProviderReply =
  | { type: 'llmChunk'; requestId: string; text: string }
  | { type: 'llmDone';  requestId: string; usage: TokenUsage | null }
  | { type: 'llmError'; requestId: string; error: unknown }

// ─── Reply type for speak — used only by the audio actor ───

export type SpeechProviderReply =
  | { type: 'llmAudioChunk'; requestId: string; data: string; format: string }
  | { type: 'llmDone';       requestId: string; usage: TokenUsage | null }
  | { type: 'llmError';      requestId: string; error: unknown }

// ─── Rerank reply ───

export type RerankReply =
  | { type: 'rerankResult'; requestId: string; scores: Array<{ index: number; score: number }>; usage: TokenUsage | null }
  | { type: 'rerankError';  requestId: string; error: string }

// ─── Video generation reply types — used by the video actor ───

export type VideoSubmitReply =
  | { type: 'videoSubmitted';    requestId: string; jobId: string; pollingUrl: string; usage: TokenUsage | null }
  | { type: 'videoSubmitError';  requestId: string; error: string }

export type VideoPollReply =
  | { type: 'videoPollResult';   requestId: string; status: 'completed' | 'failed' | 'processing'; unsigned_urls?: string[]; error?: string }
  | { type: 'videoPollError';    requestId: string; error: string }

// ─── Video download reply type — used by the video actor ───

export type VideoDownloadReply =
  | { type: 'videosDownloaded';    requestId: string; keys: string[] }
  | { type: 'videoDownloadError';  requestId: string; error: string }

// ─── Public provider messages ───

import type { HttpRequestMsg } from './routes.ts'

export type LlmProviderMsg =
  | HttpRequestMsg
  | { type: 'stream';            requestId: string; model: string; messages: ApiMessage[]; tools?: LlmTool[]; role: string; userId?: string; replyTo: ActorRef<LlmProviderReply> }
  | { type: 'streamImage';       requestId: string; model: string; messages: ApiMessage[]; role: string; userId?: string; replyTo: ActorRef<VisionProviderReply> }
  | { type: 'streamAudio';       requestId: string; model: string; messages: ApiMessage[]; voice?: string; role: string; userId?: string; replyTo: ActorRef<AudioProviderReply> }
  | { type: 'transcribe';        requestId: string; model: string; audio: { data: string; format: string }; role: string; userId?: string; replyTo: ActorRef<TranscriptionProviderReply> }
  | { type: 'speak';             requestId: string; model: string; input: string; voice: string; instructions?: string; format?: string | undefined; role: string; userId?: string; replyTo: ActorRef<SpeechProviderReply> }
  | { type: 'embed';             requestId: string; model: string; text: string; dimensions?: number; userId?: string; replyTo: ActorRef<EmbeddingReply> }
  | { type: 'fetchModelInfo';    model: string; replyTo: ActorRef<ModelInfo | null> }
  | { type: 'fetchModels';       replyTo: ActorRef<string[]> }
  | { type: 'rerank';            requestId: string; model: string; query: string; documents: string[]; topN?: number; userId?: string; replyTo: ActorRef<RerankReply> }
  | { type: 'submitVideo';       requestId: string; model: string; prompt: string; aspectRatio?: string; duration?: number; resolution?: string; role: string; userId?: string; replyTo: ActorRef<VideoSubmitReply> }
  | { type: 'pollVideo';         requestId: string; pollingUrl: string; role: string; userId?: string; replyTo: ActorRef<VideoPollReply> }
  | { type: 'downloadVideos';    requestId: string; downloads: { url: string; key: string }[]; bucket: string; persistenceRef: ActorRef<PersistenceMsg>; role: string; userId?: string; replyTo: ActorRef<VideoDownloadReply> }

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
  /** Present for per-user usage; absent for background tasks */
  userId?: string
}
export const CostTopic = createTopic<CostEvent>('cognitive.costs')
