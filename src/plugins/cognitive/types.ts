import type { ActorRef } from '../../system/index.ts'
import { createTopic } from '../../system/index.ts'
import type {
  ApiMessage,
  AudioProviderReply,
  EmbeddingReply,
  LlmProviderMsg,
  LlmProviderReply,
  LlmTool,
  ModelInfo,
  RerankReply,
  SpeechProviderReply,
  TokenUsage,
  TranscriptionProviderReply,
  VideoDownloadReply,
  VideoPollReply,
  VideoSubmitReply,
  VisionProviderReply,
} from '../../types/llm.ts'
import type { ContextTurn } from '../../types/agents.ts'

// ─── Session configuration (consumed by SessionManager) ───

export type SessionConfig = {
  defaultMode:        string   // mode for first-connect, cron routing, crash fallback. Defaults to 'chatbot'.
  contextWindowHours: number   // trim ContextStore records older than this on every append.
  contextPath?:       string
}

// ─── LLM provider adapter contracts ───

type AdapterStreamResult =
  | { type: 'content';   usage: TokenUsage | null }
  | { type: 'toolCalls'; calls: Array<{ id: string; name: string; arguments: string }>; usage: TokenUsage | null }

export type LlmProviderAdapter = {
  stream(
    model: string,
    messages: ApiMessage[],
    tools: LlmTool[] | undefined,
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

export type OpenRouterAdapterOptions = {
  apiKey: string
  reasoning?: { enabled?: boolean; effort?: 'high' | 'medium' | 'low' | 'minimal' }
}

// ─── LLM provider internal mailbox ───

export type LlmProviderInternalMsg =
  | LlmProviderMsg
  | { type: '_videoSubmitDone';   result: VideoSubmitReply;           model: string; role: string; userId?: string; replyTo: ActorRef<VideoSubmitReply> }
  | { type: '_videoPollDone';     result: VideoPollReply;             role: string; userId?: string; replyTo: ActorRef<VideoPollReply> }
  | { type: '_videoDownloadDone'; result: VideoDownloadReply;         role: string; userId?: string; replyTo: ActorRef<VideoDownloadReply> }
  | { type: '_streamDone';        result: LlmProviderReply;           model: string; role: string; userId?: string; replyTo: ActorRef<LlmProviderReply> }
  | { type: '_streamImageDone';   result: VisionProviderReply;        model: string; role: string; userId?: string; replyTo: ActorRef<VisionProviderReply> }
  | { type: '_streamAudioDone';   result: AudioProviderReply;         model: string; role: string; userId?: string; replyTo: ActorRef<AudioProviderReply> }
  | { type: '_transcribeDone';    result: TranscriptionProviderReply; model: string; role: string; userId?: string; replyTo: ActorRef<TranscriptionProviderReply> }
  | { type: '_speakDone';         result: SpeechProviderReply;        model: string; role: string; userId?: string; replyTo: ActorRef<SpeechProviderReply> }
  | { type: '_embedDone';         result: EmbeddingReply;             model: string; role: string; userId?: string; usage: TokenUsage | null; replyTo: ActorRef<EmbeddingReply> }
  | { type: '_modelInfoDone';     info: ModelInfo | null;             replyTo: ActorRef<ModelInfo | null> }
  | { type: '_modelsDone';        models: string[];                   replyTo: ActorRef<string[]> }
  | { type: '_rerankDone';        result: RerankReply;                model: string; role: string; userId?: string; usage: TokenUsage | null; replyTo: ActorRef<RerankReply> }
  | { type: '_costReady';         model: string; role: string; userId?: string; usage: TokenUsage; info: ModelInfo | null }

// ─── User context message protocol ───

export type UserContextMsg =
  | { type: '_run' }
  | { type: '_llmProvider';      ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_contextSnapshot';  userId: string; userContext: string | null; turns: ContextTurn[] }
  | LlmProviderReply

// ─── Topic: published (retained) after each context summary generation ───

export type UserContextEvent = { userId: string; summary: string }
export const UserContextTopic = createTopic<UserContextEvent>('user.context')
