import type { ActorRef, SpanHandle } from '../../system/index.ts'
import type { ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import type { LlmProviderMsg, LlmProviderReply, VisionProviderReply, VideoSubmitReply, VideoPollReply, VideoDownloadReply, TranscriptionProviderReply, SpeechProviderReply } from '../../types/llm.ts'
import type { PersistenceMsg } from '../../types/persistence.ts'
import type { BashExecResult, BashOptions } from 'just-bash'

// ─── Tools Plugin Config ───

export type ToolsConfig = {
  webSearch?: WebSearchActorOptions
  bash?: BashOptions
  vision?: {
    model: string
    analysisModel?: string
  }
  audio?: {
    ttsModel: string
    sttModel: string
    voice?: string
  }
  video?: {
    model: string
    aspectRatio?: string
    duration?: number
    resolution?: string
    pollIntervalMs?: number
    pollTimeoutMs?: number
  }
}

// ─── Web Search Actor Types ───

export type GroundingItem = {
  url: string
  title: string
  snippets: string[]
}

export type SourceInfo = {
  title: string
  hostname: string
  age: (string | null)[]
}

export type BraveLlmContextResponse = {
  grounding: {
    generic: GroundingItem[]
    poi: unknown | null
    map: unknown[]
  }
  sources: Record<string, SourceInfo>
}

export type WebSearchMsg =
  | ToolInvokeMsg
  | { type: '_done'; query: string; result: BraveLlmContextResponse; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_err'; query: string; error: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }

export type WebSearchActorOptions = {
  apiKey: string
  count?: number
}

// ─── Bash Tool Actor Types ───

export type BashToolMsg =
  | ToolInvokeMsg
  | { type: '_bashDone'; result: BashExecResult; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_bashErr'; error: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_writeDone'; path: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_writeErr'; error: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_readDone'; content: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_readErr'; error: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_editReadDone'; path: string; target: string; replacement: string; content: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_editWriteDone'; path: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }

// ─── Vision Actor Types ───

export type VisionMsg =
  | ToolInvokeMsg
  | LlmProviderReply
  | VisionProviderReply
  | { type: '_resolved';     requestId: string; imageUrl: string; prompt: string }
  | { type: '_resolveError'; requestId: string; error: string }
  | { type: '_imageSaved';   requestId: string; filePath: string; publicUrl: string }
  | { type: '_saveError';    requestId: string; error: string }
  | { type: '_llmProvider';  ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_persistenceRef'; ref: ActorRef<PersistenceMsg> | null }

export type AnalysisPending = {
  kind: 'analysis'
  accumulated: string
  replyTo: ActorRef<ToolReply>
  userId?: string
}

export type GenerationPending = {
  kind: 'generation'
  prompt: string
  streamController: ReadableStreamDefaultController<Uint8Array> | null
  replyTo: ActorRef<ToolReply>
  userId?: string
}

export type PendingRequest = AnalysisPending | GenerationPending

export type VisionState = {
  pending: Record<string, PendingRequest>
  llmRef: ActorRef<LlmProviderMsg> | null
  persistenceRef: ActorRef<PersistenceMsg> | null
}

export type VisionOptions = {
  llmRef?: ActorRef<LlmProviderMsg> | null
  persistenceRef?: ActorRef<PersistenceMsg> | null
  model: string
  analysisModel?: string
}

// ─── PDF Actor Types ───

export type PdfState = {
  persistenceRef: ActorRef<PersistenceMsg> | null
}

export type PdfMsg =
  | ToolInvokeMsg
  | { type: '_persistenceRef'; ref: ActorRef<PersistenceMsg> | null }
  | { type: '_done'; key: string; text: string; pages: number; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_err'; key: string; error: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }

// ─── Fetch File Actor Types ───

export type FetchFileState = {
  persistenceRef: ActorRef<PersistenceMsg> | null
}

export type FetchFileMsg =
  | ToolInvokeMsg
  | { type: '_persistenceRef'; ref: ActorRef<PersistenceMsg> | null }
  | { type: '_done'; url: string; key: string; contentType: string; bytes: number; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_err'; url: string; error: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }

// ─── Audio Actor Types ───

export type AudioMsg =
  | ToolInvokeMsg
  | TranscriptionProviderReply
  | SpeechProviderReply
  | { type: '_audioLoaded';    requestId: string; data: string; format: string; replyTo: ActorRef<ToolReply> }
  | { type: '_audioLoadError'; requestId: string; error: string; replyTo: ActorRef<ToolReply> }
  | { type: '_audioSaved';     requestId: string; key: string; spokenText: string; voice: string; replyTo: ActorRef<ToolReply> }
  | { type: '_audioSaveError'; requestId: string; error: string; replyTo: ActorRef<ToolReply> }
  | { type: '_llmProvider';    ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_persistenceRef'; ref: ActorRef<PersistenceMsg> | null }

export type TranscriptionPending = {
  kind: 'transcription'
  accumulated: string
  replyTo: ActorRef<ToolReply>
  userId?: string
}

export type TtsPending = {
  kind: 'tts'
  streamController: ReadableStreamDefaultController<Uint8Array> | null
  audioFormat: string
  spokenText: string
  voice: string
  replyTo: ActorRef<ToolReply>
  userId?: string
}

export type AudioState = {
  pending: Record<string, TranscriptionPending | TtsPending>
  llmRef: ActorRef<LlmProviderMsg> | null
  persistenceRef: ActorRef<PersistenceMsg> | null
}

export type AudioOptions = {
  llmRef?: ActorRef<LlmProviderMsg> | null
  persistenceRef?: ActorRef<PersistenceMsg> | null
  ttsModel: string
  sttModel: string
  voice: string
  ttsFormat?: string
}

// ─── Cron Actor Types ───

export type CronJob = {
  id: string
  expression: string
  prompt: string
  runOnce: boolean
  createdAt: number
  lastFiredAt: number | null
  nextFireAt: number
  userId: string
}

export type CronState = {
  jobs: Record<string, CronJob>
}

// ─── Video Actor Types ───

export type VideoMsg =
  | ToolInvokeMsg
  | VideoSubmitReply
  | VideoPollReply
  | VideoDownloadReply
  | { type: '_pollTick'; requestId: string }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_persistenceRef'; ref: ActorRef<PersistenceMsg> | null }

export type PendingJob = {
  requestId: string
  jobId: string
  pollingUrl: string
  replyTo: ActorRef<ToolReply>
  userId: string
  deadline: number
}

export type VideoState = {
  pending: Record<string, PendingJob>
  llmRef: ActorRef<LlmProviderMsg> | null
  persistenceRef: ActorRef<PersistenceMsg> | null
}

export type VideoOptions = {
  llmRef?: ActorRef<LlmProviderMsg> | null
  model: string
  aspectRatio?: string
  duration?: number
  resolution?: string
  pollIntervalMs?: number
  pollTimeoutMs?: number
}

// ─── Tool Status Actor Types ───

export type JobInfo = {
  toolName:  string
  toolRef:   ActorRef<any>
  startedAt: number
  userId?:   string
  statusText?: string
  result?:   any
  error?:    string
}

export type ToolStatusState = { jobs: Record<string, JobInfo> }
