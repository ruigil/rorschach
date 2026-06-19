import type { ActorRef } from '../../system/index.ts'
import type { BashExecResult } from 'just-bash'
import type { ContextSnapshotEvent } from '../../types/agents.ts'
import type { MessageAttachment } from '../../types/events.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import type { ToolCollection, ToolFinalReply, ToolInvokeMsg, ToolMsg, ToolReply } from '../../types/tools.ts'
import type { ContextView, LoopMsg, LoopState, SpanHandle } from '../../system/index.ts'

export type CodingConfig = {
  projectRoot: string
  projectMount: string
  artifactsDir: string
  workspaceDir?: string
  coding: {
    model: string
    maxToolLoops: number
  }
  docs: {
    model: string
    maxToolLoops: number
  }
}

export type DocPageMeta = {
  title: string
  filename: string
  summary: string
  sourcePaths: string[]
  createdAt: string
}

export type DocsManifest = {
  generatedAt: string
  query: string
  pages: DocPageMeta[]
}

export type CodingAgentExtra =
  | { type: 'userMessage'; text: string; attachments?: MessageAttachment[]; isInjected?: boolean }
  | ({ type: '_contextSnapshot' } & ContextSnapshotEvent)

export type CodingAgentMsg = LoopMsg<CodingAgentExtra>

export type CodingAgentState = {
  loop: LoopState
  contextView: ContextView
}

export type DocsJobExecutorExtra =
  | { type: 'startJob'; userId: string }

export type DocsJobExecutorMsg = LoopMsg<DocsJobExecutorExtra>

export type DocsJobExecutorState = {
  loop: LoopState
  llmRef: ActorRef<LlmProviderMsg> | null
  pagesWritten: number
  startedAt: number
  userId?: string
}

export type DocsAgentMsg =
  | { type: 'invoke' } & ToolInvokeMsg
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_pagesWrittenUpdated'; jobId: string; pagesWritten: number }
  | { type: '_jobCompleted'; jobId: string }
  | { type: '_jobFailed'; jobId: string; error: string }

export type DocsAgentState = {
  llmRef: ActorRef<LlmProviderMsg> | null
  activeJobs: Record<string, {
    jobId: string
    executorRef: ActorRef<DocsJobExecutorMsg>
    query: string
    userId: string
    pagesWritten: number
  }>
}

export type ArtifactState = {
  writing: boolean
}

export type ProjectShellMsg =
  | ToolMsg
  | { type: '_bashDone'; result: BashExecResult; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_bashErr'; error: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_readDone'; content: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_readErr'; error: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }

export type ArtifactToolsMsg =
  | ToolInvokeMsg
  | { type: '_done' }
  | { type: '_writeDone'; replyTo: ActorRef<ToolReply>; text: string; span: SpanHandle | null }
  | { type: '_writeErr'; replyTo: ActorRef<ToolReply>; error: string; span: SpanHandle | null }

export type DocsAgentOptions = {
  model: string
  maxToolLoops: number
  projectMount: string
  artifactsDir: string
  tools: ToolCollection
}
