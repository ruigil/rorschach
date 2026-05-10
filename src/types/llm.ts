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
  | { type: 'videosDownloaded';    requestId: string; destPaths: string[] }
  | { type: 'videoDownloadError';  requestId: string; error: string }

// ─── Incoming messages ───

export type LlmProviderMsg =
  | { type: 'stream';            requestId: string; model: string; messages: ApiMessage[]; tools?: Tool[]; role: string; clientId?: string; replyTo: ActorRef<LlmProviderReply> }
  | { type: 'streamImage';       requestId: string; model: string; messages: ApiMessage[]; role: string; clientId?: string; replyTo: ActorRef<VisionProviderReply> }
  | { type: 'streamAudio';       requestId: string; model: string; messages: ApiMessage[]; voice?: string; role: string; clientId?: string; replyTo: ActorRef<AudioProviderReply> }
  | { type: 'transcribe';        requestId: string; model: string; audio: { data: string; format: string }; role: string; clientId?: string; replyTo: ActorRef<TranscriptionProviderReply> }
  | { type: 'speak';             requestId: string; model: string; input: string; voice: string; instructions?: string; format?: string | undefined; role: string; clientId?: string; replyTo: ActorRef<SpeechProviderReply> }
  | { type: 'embed';             requestId: string; model: string; text: string; dimensions?: number; clientId?: string; replyTo: ActorRef<EmbeddingReply> }
  | { type: 'fetchModelInfo';    model: string; replyTo: ActorRef<ModelInfo | null> }
  | { type: 'fetchModels';       replyTo: ActorRef<string[]> }
  | { type: 'rerank';            requestId: string; model: string; query: string; documents: string[]; topN?: number; clientId?: string; replyTo: ActorRef<RerankReply> }
  | { type: 'submitVideo';       requestId: string; model: string; prompt: string; aspectRatio?: string; duration?: number; resolution?: string; role: string; clientId?: string; replyTo: ActorRef<VideoSubmitReply> }
  | { type: 'pollVideo';         requestId: string; pollingUrl: string; role: string; clientId?: string; replyTo: ActorRef<VideoPollReply> }
  | { type: 'downloadVideos';    requestId: string; downloads: { url: string; destPath: string }[]; role: string; clientId?: string; replyTo: ActorRef<VideoDownloadReply> }
  | { type: '_videoSubmitDone';  result: VideoSubmitReply; model: string; role: string; clientId?: string; replyTo: ActorRef<VideoSubmitReply> }
  | { type: '_videoPollDone';    result: VideoPollReply; role: string; clientId?: string; replyTo: ActorRef<VideoPollReply> }
  | { type: '_videoDownloadDone'; result: VideoDownloadReply; role: string; clientId?: string; replyTo: ActorRef<VideoDownloadReply> }
  | { type: '_streamDone';       result: LlmProviderReply; model: string; role: string; clientId?: string; replyTo: ActorRef<LlmProviderReply> }
  | { type: '_streamImageDone';  result: VisionProviderReply; model: string; role: string; clientId?: string; replyTo: ActorRef<VisionProviderReply> }
  | { type: '_streamAudioDone';  result: AudioProviderReply; model: string; role: string; clientId?: string; replyTo: ActorRef<AudioProviderReply> }
  | { type: '_transcribeDone';   result: TranscriptionProviderReply; model: string; role: string; clientId?: string; replyTo: ActorRef<TranscriptionProviderReply> }
  | { type: '_speakDone';        result: SpeechProviderReply; model: string; role: string; clientId?: string; replyTo: ActorRef<SpeechProviderReply> }
  | { type: '_embedDone';        result: EmbeddingReply; model: string; role: string; clientId?: string; usage: TokenUsage | null; replyTo: ActorRef<EmbeddingReply> }
  | { type: '_modelInfoDone';    info: ModelInfo | null; replyTo: ActorRef<ModelInfo | null> }
  | { type: '_modelsDone';       models: string[]; replyTo: ActorRef<string[]> }
  | { type: '_rerankDone';       result: RerankReply; model: string; role: string; clientId?: string; usage: TokenUsage | null; replyTo: ActorRef<RerankReply> }
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
  transcribe(
    model: string,
    audio: { data: string; format: string },
  ): Promise<{ text: string; usage: TokenUsage | null }>
  speak(
    model: string,
    input: string,
    voice: string,
    instructions: string | undefined,
    format: string | undefined,
  ): Promise<{ data: string; format: string; usage: TokenUsage | null }>
  embed(model: string, text: string, dimensions?: number): Promise<{ embedding: number[]; usage: TokenUsage | null }>
  fetchModelInfo(model: string): Promise<ModelInfo | null>
  fetchModels(): Promise<string[]>
  rerank(model: string, query: string, documents: string[], topN?: number): Promise<{ scores: Array<{ index: number; score: number }>; usage: TokenUsage | null }>
  submitVideoGeneration(model: string, prompt: string, aspectRatio?: string, duration?: number, resolution?: string): Promise<{ jobId: string; pollingUrl: string }>
  pollVideoGeneration(pollingUrl: string): Promise<{ status: 'completed' | 'failed' | 'processing'; unsigned_urls?: string[]; error?: string }>
  downloadVideos(downloads: { url: string; destPath: string }[]): Promise<void>
}

// ─── OpenRouter adapter options ───

export type OpenRouterAdapterOptions = {
  apiKey: string
  reasoning?: { enabled?: boolean; effort?: 'high' | 'medium' | 'low' | 'minimal' }
}
