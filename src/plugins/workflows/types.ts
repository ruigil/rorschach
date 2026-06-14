import { createTopic, type ActorRef } from '../../system/index.ts'
import type { ToolInvokeMsg, ToolCollection, ToolReply, ToolMsg, ToolSchema } from '../../types/tools.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import type { LoopMsg, LoopState } from '../../system/index.ts'
import type { MessageAttachment } from '../../types/events.ts'
import type { ContextView } from '../../system/index.ts'
import type { ContextSnapshotEvent } from '../../types/agents.ts'

export type WorkflowTask = {
  id: string
  name: string
  description: string
  validationCriteria: string
  dependencies: string[]
  outputs?: Record<string, WorkflowValueSpec>
}

export type Workflow = {
  id: string
  userId: string
  goal: string
  context: string
  createdAt: string
  executionTools: string[]
  inputs?: Record<string, WorkflowValueSpec>
  outputs?: Record<string, WorkflowValueSpec>
  tasks: WorkflowTask[]
}

export type WorkflowValueSpec = {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'artifact'
  required?: boolean
  description?: string
}

export type WorkflowArtifactRef =
  | {
      type: 'artifact'
      path: string
      mimeType?: string
    }
  | {
      type: 'artifact'
      url: string
      mimeType?: string
      name?: string
    }

export type WorkflowOutputValue =
  | string
  | number
  | boolean
  | Record<string, unknown>
  | unknown[]
  | WorkflowArtifactRef

export type WorkflowDependencyOutput = {
  summary?: string
  outputs?: Record<string, WorkflowOutputValue>
}

export type WorkflowsConfig = {
  workflowsDir: string
  workflowRunsDir: string
  workflows: {
    model: string
    maxToolLoops: number
  }
}

export type WorkflowSummary = {
  id: string
  userId: string
  goal: string
  createdAt: string
  taskCount: number
  filepath: string
}

export type WorkflowTaskStatus = 'pending' | 'running' | 'blocked' | 'failed' | 'completed'
export type WorkflowRunStatus = 'running' | 'blocked' | 'failed' | 'completed'

export type WorkflowTaskBlockedReason =
  | { type: 'missing_pending_job'; jobId: string; toolName: string }
  | { type: 'task_blocked'; message: string }

export type WorkflowTaskRunState = {
  status: WorkflowTaskStatus
  attempts: number
  startedAt?: string
  completedAt?: string
  summary?: string
  outputs?: Record<string, WorkflowOutputValue>
  error?: string
  blockedReason?: WorkflowTaskBlockedReason
}

export type WorkflowRunState = {
  schemaVersion: number
  runId: string
  workflowId: string
  userId: string
  clientId?: string
  status: WorkflowRunStatus
  inputs: Record<string, unknown>
  outputs: Record<string, WorkflowOutputValue>
  activeTaskIds: string[]
  taskStates: Record<string, WorkflowTaskRunState>
  activeTasks: Record<string, {
    actorName: string
    startedAt: string
  }>
  pendingJobs: Record<string, {
    taskId: string
    toolName: string
    toolCallId?: string
    startedAt: string
  }>
  events: Array<{
    timestamp: string
    type: string
    taskId?: string
    message: string
  }>
}

export type WorkflowRunUpdateEvent = {
  userId: string
  workflowId: string
  runId: string
  run: WorkflowRunState
}

export const WorkflowRunUpdateTopic = createTopic<WorkflowRunUpdateEvent>('workflow.run.updated')

export type WorkflowGraphNode = {
  id: string
  label: string
  description: string
  validationCriteria: string
  dependencies: string[]
  dependents: string[]
  status: WorkflowTaskStatus | 'not_tracked'
  attempts?: number
  startedAt?: string
  completedAt?: string
  summary?: string
  outputs?: Record<string, WorkflowOutputValue>
  error?: string
  blockedReason?: WorkflowTaskBlockedReason
}

export type WorkflowGraphEdge = {
  source: string
  target: string
  type: 'depends_on'
}

export type WorkflowGraph = {
  workflow: {
    id: string
    userId: string
    goal: string
    context: string
    createdAt: string
    taskCount: number
    executionTools: string[]
    inputs?: Record<string, WorkflowValueSpec>
    outputs?: Record<string, WorkflowValueSpec>
  }
  run?: {
    runId: string
    status: WorkflowRunStatus
    inputs: Record<string, unknown>
    activeTaskIds: string[]
    activeTasks: WorkflowRunState['activeTasks']
    pendingJobs: WorkflowRunState['pendingJobs']
    outputs?: Record<string, WorkflowOutputValue>
    events: WorkflowRunState['events']
  }
  nodes: WorkflowGraphNode[]
  edges: WorkflowGraphEdge[]
}

export type ExecutionToolSummary = {
  name: string
  description: string
  mayBeLongRunning?: boolean
}

export type WorkflowStoreReply =
  | { ok: true; workflows: WorkflowSummary[] }
  | { ok: true; workflow: Workflow; filepath: string }
  | { ok: true; graph: WorkflowGraph }
  | { ok: true; deleted: true; workflowId: string }
  | { ok: true; updated: true; workflow: Workflow; filepath: string }
  | { ok: false; error: string; status?: number }

export type WorkflowStoreMsg =
  | { type: 'list'; userId: string; replyTo: ActorRef<WorkflowStoreReply> }
  | { type: 'get'; userId: string; workflowId: string; replyTo: ActorRef<WorkflowStoreReply> }
  | { type: 'graph'; userId: string; workflowId: string; run?: WorkflowRunState; replyTo: ActorRef<WorkflowStoreReply> }
  | { type: 'save'; workflow: Workflow; replyTo: ActorRef<WorkflowStoreReply> }
  | { type: 'update'; userId: string; workflowId: string; patch: { goal?: string; context?: string; executionTools?: string[]; inputs?: Record<string, WorkflowValueSpec>; outputs?: Record<string, WorkflowValueSpec>; tasks?: WorkflowTask[] }; replyTo: ActorRef<WorkflowStoreReply> }
  | { type: 'delete'; userId: string; workflowId: string; replyTo: ActorRef<WorkflowStoreReply> }
  | { type: '_done' }

export type WorkflowRunnerReply =
  | { ok: true; run: WorkflowRunState }
  | { ok: true; runs: WorkflowRunState[] }
  | { ok: true; executionTools: ExecutionToolSummary[] }
  | { ok: false; error: string; status?: number }

export type WorkflowRunnerMsg =
  | { type: 'start'; userId: string; clientId?: string; workflowId: string; inputs?: Record<string, unknown>; replyTo: ActorRef<WorkflowRunnerReply> }
  | { type: 'list'; userId: string; replyTo: ActorRef<WorkflowRunnerReply> }
  | { type: 'listExecutionTools'; replyTo: ActorRef<WorkflowRunnerReply> }
  | { type: 'get'; userId: string; runId: string; replyTo: ActorRef<WorkflowRunnerReply> }
  | { type: 'resume'; userId: string; runId: string; replyTo: ActorRef<WorkflowRunnerReply> }
  | { type: '_reply'; replyTo: ActorRef<WorkflowRunnerReply>; reply: WorkflowRunnerReply; live?: Record<string, ActorRef<WorkflowRunExecutorMsg>> }
  | { type: '_toolRegistered'; tool: import('../../types/tools.ts').Tool }
  | { type: '_toolUnregistered'; name: string }
  | { type: '_clientConnected'; userId: string; clientId: string }
  | { type: '_clientDisconnected'; clientId: string }
  | { type: '_runUpdated'; event: WorkflowRunUpdateEvent }
  | { type: '_done' }

export type WorkflowRunExecutorReply =
  | { ok: true; run: WorkflowRunState }
  | { ok: false; error: string; status?: number }

export type WorkflowRunExecutorMsg =
  | { type: 'start'; replyTo: ActorRef<WorkflowRunExecutorReply> }
  | { type: 'get'; replyTo: ActorRef<WorkflowRunExecutorReply> }
  | { type: 'resume'; replyTo: ActorRef<WorkflowRunExecutorReply> }
  | { type: 'taskWaiting'; taskId: string; actorName: string; jobId: string; toolName: string; toolCallId?: string }
  | { type: 'taskCompleted'; taskId: string; summary: string; outputs: Record<string, WorkflowOutputValue> }
  | { type: 'taskBlocked'; taskId: string; message: string }
  | { type: 'taskFailed'; taskId: string; error: string }
  | { type: '_jobRegistry'; event: import('../../types/tools.ts').JobLifecycleEvent }
  | { type: '_done' }

export type WorkflowTaskExecutorMsg =
  | LoopMsg<{
      type: 'startTask'
      workflow: Workflow
      task: WorkflowTask
      inputs: Record<string, unknown>
      artifactRoot: string
      dependencyOutputs: Record<string, WorkflowDependencyOutput>
      resumeContext?: string
      userId: string
      clientId?: string
    }>
  | ToolInvokeMsg

export type WorkflowToolsMsg =
  | ToolInvokeMsg
  | { type: '_done' }
  | { type: '_reply'; replyTo: ActorRef<ToolReply>; reply: ToolReply }

export type WorkflowsAgentExtra =
  | { type: 'userMessage'; clientId: string; text: string; attachments?: MessageAttachment[]; isInjected?: boolean }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }
  | ({ type: '_contextSnapshot' } & ContextSnapshotEvent)
  | { type: '_toolRegistered'; name: string; schema: ToolSchema; ref: ActorRef<ToolMsg>; mayBeLongRunning?: boolean }
  | { type: '_toolUnregistered'; name: string }

export type WorkflowsAgentMsg = LoopMsg<WorkflowsAgentExtra>

export type WorkflowsAgentState = {
  loop: LoopState
  contextView: ContextView
  tools: ToolCollection
  pendingSaveSummary: string | null
  activeClientId: string
}
