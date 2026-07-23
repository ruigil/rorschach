import type { ActorRef } from '../../system/index.ts'
import type { BashExecResult } from 'just-bash'
import type { ContextSnapshotEvent, AgentModelOptions } from '../../types/agents.ts'
import type { MessageAttachment, HttpWsFrameEvent } from '../../types/events.ts'
import type { ToolCollection, ToolInvokeMsg, ToolMsg, ToolReply, ToolSchema } from '../../types/tools.ts'
import type { ContextView, LoopMsg, LoopState, SpanHandle } from '../../system/index.ts'
import type { HttpRequestMsg } from '../../types/routes.ts'

export type CodingConfig = {
  projectRoot: string
  projectMount: string
  workspaceDir?: string
  coding: AgentModelOptions
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

export type TocNode = {
  title: string
  filename?: string
  children?: TocNode[]
}

export type PageToolsState = {
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

export type PageToolsMsg =
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
