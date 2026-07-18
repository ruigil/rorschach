import type { ActorRef } from '../../system/index.ts'
import type { BashExecResult } from 'just-bash'
import type { ContextSnapshotEvent, AgentModelOptions } from '../../types/agents.ts'
import type { MessageAttachment, HttpWsFrameEvent } from '../../types/events.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import type { ToolCollection, ToolFinalReply, ToolInvokeMsg, ToolMsg, ToolReply, ToolSchema } from '../../types/tools.ts'
import type { ContextView, LoopMsg, LoopState, SpanHandle } from '../../system/index.ts'

export type CodingConfig = {
  projectRoot: string
  projectMount: string
  artifactsDir?: string
  workspaceDir?: string
  coding: AgentModelOptions
  docs: AgentModelOptions
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
  | { type: '_toolRegistered'; name: string; schema: ToolSchema; ref: ActorRef<ToolMsg>; mayBeLongRunning?: boolean }
  | { type: '_toolUnregistered'; name: string }

export type CodingAgentMsg = LoopMsg<CodingAgentExtra>

export type CodingAgentState = {
  loop: LoopState
  contextView: ContextView
  tools: ToolCollection
}

export type DocsJobExecutorExtra =
  | { type: 'startJob'; userId: string }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }

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
  persistenceRef: ActorRef<any> | null
}

export type ProjectShellState = {
  cwd: string
}

export type ProjectShellMsg =
  | ToolMsg
  | { type: '_wsFrame'; event: HttpWsFrameEvent }
  | { type: '_wsBashDone'; result: BashExecResult; userId: string; cmdId: string }
  | { type: '_wsBashErr'; error: string; userId: string; cmdId: string }
  | { type: '_wsAutocompleteDone'; result: BashExecResult; userId: string; cmdId: string }
  | { type: '_wsAutocompleteErr'; error: string; userId: string; cmdId: string }
  | { type: '_bashDone'; result: BashExecResult; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_bashErr'; error: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_readDone'; content: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_readErr'; error: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }

import type { HttpRequestMsg } from '../../types/routes.ts'

export type ArtifactToolsMsg =
  | HttpRequestMsg
  | ToolInvokeMsg
  | { type: '_done' }
  | { type: '_writeDone'; replyTo: ActorRef<ToolReply>; text: string; span: SpanHandle | null }
  | { type: '_writeErr'; replyTo: ActorRef<ToolReply>; error: string; span: SpanHandle | null }
  | { type: 'getDoc'; filename: string; replyTo: ActorRef<{ ok: true; content: string } | { ok: false; error: string }> }
  | { type: '_persistenceRef'; ref: ActorRef<any> | null }

export type CodingAgentOptions = AgentModelOptions & {
  projectMount: string
  tools: ToolCollection
}

export type DocsAgentOptions = AgentModelOptions & {
  maxToolLoops: number
  projectMount: string
  tools: ToolCollection
}
