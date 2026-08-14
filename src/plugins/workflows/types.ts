import { createTopic, type ActorRef } from '../../system/index.ts'
import type { JobLifecycleEvent } from '../../types/tools.ts'
import type { LlmProviderMsg, ApiMessage } from '../../types/llm.ts'
import type { LoopMsg } from '../../system/index.ts'
import type { MessageAttachment, HttpWsFrameEvent } from '../../types/events.ts'
import type { ContextSnapshotEvent } from '../../types/agents.ts'
import type { SCRReply, SCRInvokeMsg } from '../../types/scr.ts'

export type WorkflowTask = {
  id: string
  name: string
  description: string
  validationCriteria: string
  dependencies: string[]
  agentMode: string
  executionTools?: string[]
  outputs?: Record<string, WorkflowValueSpec>
}

export type Workflow = {
  id: string
  userId: string
  title: string
  goal: string
  context: string
  createdAt: string
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
      key: string
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

export type { WorkflowsConfig } from './workflows.config.ts'

export type WorkflowRunnerConfig = {
  llmRef: ActorRef<LlmProviderMsg> | null
  model: string
  maxToolLoops: number
}

export type WorkflowSummary = {
  id: string
  userId: string
  title: string
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
  history?: ApiMessage[]
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
  workflow: Workflow
}

export type WorkflowEvent = {
  userId: string
  workflowId: string
  runId?: string
  run?: WorkflowRunState
}

export const WorkflowEventTopic = createTopic<WorkflowEvent>('workflow.event')

export type WorkflowGraphNode = {
  id: string
  label: string
  description: string
  validationCriteria: string
  dependencies: string[]
  dependents: string[]
  agentMode: string
  executionTools?: string[]
  status: WorkflowTaskStatus | 'not_tracked'
  attempts?: number
  startedAt?: string
  completedAt?: string
  summary?: string
  outputs?: Record<string, WorkflowOutputValue> | Record<string, WorkflowValueSpec>
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
    title: string
    goal: string
    context: string
    createdAt: string
    taskCount: number
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

export type AgentModeSummary = {
  mode: string
  displayName: string
  shortDesc: string
}



export type WorkflowRunExecutorReply =
  | { ok: true; run: WorkflowRunState }
  | { ok: false; error: string; status?: number }

export type WorkflowRunExecutorMsg =
  | { type: 'start'; replyTo: ActorRef<WorkflowRunExecutorReply> }
  | { type: 'get'; replyTo: ActorRef<WorkflowRunExecutorReply> }
  | { type: 'resume'; replyTo: ActorRef<WorkflowRunExecutorReply> }
  | { type: 'taskWaiting'; taskId: string; actorName: string; jobId: string; toolName: string; toolCallId?: string; history?: ApiMessage[] }
  | { type: 'taskCompleted'; taskId: string; summary: string; outputs: Record<string, WorkflowOutputValue> }
  | { type: 'taskBlocked'; taskId: string; message: string }
  | { type: 'taskFailed'; taskId: string; error: string }
  | { type: '_jobRegistry'; event: JobLifecycleEvent }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_done' }

export type WorkflowTaskExecutorMsg =
  | LoopMsg<{
      type: 'startTask'
      runId: string
      workflow: Workflow
      task: WorkflowTask
      inputs: Record<string, unknown>
      dependencyOutputs: Record<string, WorkflowDependencyOutput>
      history?: ApiMessage[]
      userId: string
      clientId?: string
    } | {
      type: '_llmProvider'
      ref: ActorRef<LlmProviderMsg> | null
    } | {
      type: '_persistenceRef'
      ref: ActorRef<any> | null
    }>
  | SCRInvokeMsg
  | { type: '_scrReply'; taskId: string; reply: SCRReply }

export type WorkflowsAgentExtra =
  | { type: 'userMessage'; text: string; attachments?: MessageAttachment[]; isInjected?: boolean }
  | ({ type: '_contextSnapshot' } & ContextSnapshotEvent)

export type WorkflowsAgentMsg = LoopMsg<WorkflowsAgentExtra>


