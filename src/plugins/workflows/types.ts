import type { ActorRef } from '../../system/index.ts'
import type { ToolInvokeMsg, ToolCollection, ToolFilter, ToolMsg } from '../../types/tools.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import type { LoopMsg, LoopState } from '../../system/index.ts'
import type { MessageAttachment } from '../../types/events.ts'
import type { ContextView } from '../../system/index.ts'
import type { ContextSnapshotEvent } from '../../types/agents.ts'

export type PlanTask = {
  id:                 string
  name:               string
  description:        string
  validationCriteria: string
  dependencies:       string[]
}

export type Plan = {
  id:        string
  goal:      string
  context:   string
  createdAt: string
  tasks:     PlanTask[]
}

export type WorkflowsConfig = {
  plansDir: string
  executor: {
    model: string
    maxToolLoops: number
  }
  planner: {
    model: string
    maxToolLoops: number
    toolFilter?: ToolFilter
  }
}

export type PlanSummary = {
  id: string
  goal: string
  createdAt: string
  taskCount: number
  filepath: string
}

export type PlanGraphNode = {
  id: string
  label: string
  description: string
  validationCriteria: string
  dependencies: string[]
  dependents: string[]
  status: 'not_tracked'
}

export type PlanGraphEdge = {
  source: string
  target: string
  type: 'depends_on'
}

export type PlanGraph = {
  plan: {
    id: string
    goal: string
    context: string
    createdAt: string
    taskCount: number
  }
  nodes: PlanGraphNode[]
  edges: PlanGraphEdge[]
}

export type PlanStoreReply =
  | { ok: true; plans: PlanSummary[] }
  | { ok: true; plan: Plan; filepath: string }
  | { ok: true; graph: PlanGraph }
  | { ok: true; deleted: true; planId: string }
  | { ok: true; updated: true; plan: Plan; filepath: string }
  | { ok: false; error: string; status?: number }

export type PlanStoreMsg =
  | { type: 'list'; replyTo: ActorRef<PlanStoreReply> }
  | { type: 'get'; planId: string; replyTo: ActorRef<PlanStoreReply> }
  | { type: 'graph'; planId: string; replyTo: ActorRef<PlanStoreReply> }
  | { type: 'update'; planId: string; patch: { goal?: string; context?: string; tasks?: PlanTask[] }; replyTo: ActorRef<PlanStoreReply> }
  | { type: 'delete'; planId: string; replyTo: ActorRef<PlanStoreReply> }
  | { type: '_done' }

export type WorkflowToolsMsg =
  | ToolInvokeMsg
  | { type: '_done' }
  | { type: '_writeDone'; filepath: string; taskCount: number; planId: string; clientId?: string; replyTo: ActorRef<import('../../types/tools.ts').ToolReply>; span: import('../../system/index.ts').SpanHandle | null }
  | { type: '_writeErr';  error: string;    replyTo: ActorRef<import('../../types/tools.ts').ToolReply>; span: import('../../system/index.ts').SpanHandle | null }


export type ExecutorAgentExtra =
  | { type: 'userMessage'; clientId: string; text: string; attachments?: MessageAttachment[]; isInjected?: boolean }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }
  | ({ type: '_contextSnapshot' } & ContextSnapshotEvent)

export type ExecutorAgentMsg = LoopMsg<ExecutorAgentExtra>

export type PlannerExtra =
  | { type: 'userMessage'; clientId: string; text: string; attachments?: MessageAttachment[]; isInjected?: boolean }
  | { type: '_toolRegistered'; name: string; schema: import('../../types/tools.ts').ToolSchema; ref: ActorRef<ToolMsg>; mayBeLongRunning?: boolean }
  | { type: '_toolUnregistered'; name: string }
  | ({ type: '_contextSnapshot' } & ContextSnapshotEvent)

export type PlannerAgentMsg = LoopMsg<PlannerExtra>

export type PlannerAgentState = {
  loop:                    LoopState
  contextView:             ContextView
  tools:                   ToolCollection
  pendingFormalizeSummary: string | null
  activeClientId:          string
}
