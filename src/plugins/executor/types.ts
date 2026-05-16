import type { ActorRef } from '../../system/types.ts'
import type { ToolInvokeMsg } from '../../types/tools.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import type { HistoryStoreMsg } from '../cognitive/history-store.ts'
import type { Plan } from '../cognitive/types.ts'
import type { LoopMsg } from '../../system/agent-loop.ts'

export type ExecutorConfig = {
  plansDir: string
  model: string
  maxToolLoops: number
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
  | { ok: false; error: string; status?: number }

export type PlanStoreMsg =
  | { type: 'list'; replyTo: ActorRef<PlanStoreReply> }
  | { type: 'get'; planId: string; replyTo: ActorRef<PlanStoreReply> }
  | { type: 'graph'; planId: string; replyTo: ActorRef<PlanStoreReply> }
  | { type: '_done' }

export type ExecutorToolsMsg = ToolInvokeMsg | { type: '_done' }

export type ExecutorAgentExtra =
  | { type: 'userMessage'; clientId: string; text: string; images?: string[]; audio?: string; pdfs?: string[]; isCron?: boolean; isInjected?: boolean }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }

export type ExecutorAgentMsg = LoopMsg<ExecutorAgentExtra>

export type ExecutorAgentFactoryOpts = {
  userId: string
  clientId: string
  llmRef: ActorRef<LlmProviderMsg>
  historyStoreRef: ActorRef<HistoryStoreMsg>
}
