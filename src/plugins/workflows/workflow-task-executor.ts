import type { ActorContext, ActorDef, ActorRef, ActorResult, Interceptor } from '../../system/index.ts'
import { agentLoop, idleLoopState } from '../../system/index.ts'
import type { ToolCollection } from '../../types/tools.ts'
import type { ApiMessage, LlmProviderMsg } from '../../types/llm.ts'
import type {
  WorkflowRunExecutorMsg,
  WorkflowTaskExecutorMsg,
  WorkflowTask,
  Workflow,
  WorkflowDependencyOutput,
  WorkflowOutputValue,
} from './types.ts'
import { validateOutputValues } from './validation.ts'

type TaskExecutorState = {
  loop: ReturnType<typeof idleLoopState>
  workflow: Workflow | null
  task: WorkflowTask | null
  inputs: Record<string, unknown>
  artifactRoot: string
  dependencyOutputs: Record<string, WorkflowDependencyOutput>
  tools: ToolCollection
  userId: string
  clientId?: string
}

const initialState = (tools: ToolCollection): TaskExecutorState => ({
  loop: idleLoopState(),
  workflow: null,
  task: null,
  inputs: {},
  artifactRoot: '',
  dependencyOutputs: {},
  tools,
  userId: '',
})

export const parseTaskCompletion = (
  task: WorkflowTask,
  finalText: string,
): { ok: true; summary: string; outputs: Record<string, WorkflowOutputValue> } | { ok: false; error: string } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(finalText)
  } catch {
    return { ok: false, error: 'Task final response must be valid JSON.' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'Task final response must be a JSON object.' }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.summary !== 'string' || !obj.summary.trim()) return { ok: false, error: 'Task final response must include a non-empty summary string.' }
  const outputs = obj.outputs ?? {}
  const validated = validateOutputValues(`task ${task.id}`, task.outputs, outputs as Record<string, unknown>)
  if (!validated.ok) return validated
  return { ok: true, summary: obj.summary, outputs: validated.values }
}

const buildMessages = (
  workflow: Workflow,
  task: WorkflowTask,
  inputs: Record<string, unknown>,
  artifactRoot: string,
  dependencyOutputs: Record<string, WorkflowDependencyOutput>,
): ApiMessage[] => [
  {
    role: 'system',
    content: `You execute exactly one workflow task.

Complete the task using only available tools. If the task cannot be completed, explain why it is blocked.

When the task is complete, respond with exactly one JSON object and no surrounding prose:
{
  "summary": "short human-readable completion summary",
  "outputs": {}
}

The outputs object must contain only declared task output keys. Required outputs must be present. If an output is an artifact, write the file under artifactRoot using an available execution tool and return an artifact reference with a relative path, for example { "type": "artifact", "path": "generated-page.html", "mimeType": "text/html" }. Do not inline large generated files into JSON outputs.

Workflow goal: ${workflow.goal}
Workflow context: ${workflow.context}
Run inputs:
${JSON.stringify(inputs, null, 2)}
Artifact root:
${artifactRoot}
Task id: ${task.id}
Task name: ${task.name}
Task description: ${task.description}
Validation criteria: ${task.validationCriteria}
Declared task outputs:
${JSON.stringify(task.outputs ?? {}, null, 2)}
Dependency outputs:
${JSON.stringify(dependencyOutputs, null, 2)}`,
  },
  {
    role: 'user',
    content: `Execute workflow task "${task.name}" and finish with the required JSON object once the validation criteria are satisfied.`,
  },
]

export const WorkflowTaskExecutor = (
  parentRef: ActorRef<WorkflowRunExecutorMsg>,
  llmRef: ActorRef<LlmProviderMsg> | null,
  model: string,
  maxToolLoops: number,
  tools: ToolCollection,
): ActorDef<WorkflowTaskExecutorMsg, TaskExecutorState> => {
  type M = WorkflowTaskExecutorMsg
  type S = TaskExecutorState
  type Ctx = ActorContext<M>

  const loop = agentLoop<S, M>({
    role: 'workflow-task',
    spanName: 'workflow-task',
    logPrefix: 'workflow-task',
    model,
    maxToolLoops,
    llmRef: () => llmRef,
    tools: state => state.tools,
    toolInvocation: {
      jobMetadata: (call, turn) => ({
        workflowTask: true,
        userId: turn.userId,
        toolCallId: call.id,
      }),
    },
    onComplete: (state, finalText) => {
      if (state.task) {
        const parsed = parseTaskCompletion(state.task, finalText)
        if (parsed.ok) parentRef.send({ type: 'taskCompleted', taskId: state.task.id, summary: parsed.summary, outputs: parsed.outputs })
        else parentRef.send({ type: 'taskFailed', taskId: state.task.id, error: parsed.error })
      }
      return { state }
    },
    onError: (state, err) => {
      if (state.task) {
        const error = err.kind === 'loopLimit'
          ? `Tool loop limit reached. ${err.finalText}`.trim()
          : String(err.error)
        parentRef.send({ type: 'taskFailed', taskId: state.task.id, error })
      }
      return { state }
    },
    onToolPending: (state, pending, ctx) => {
      if (state.task) {
        parentRef.send({
          type: 'taskWaiting',
          taskId: state.task.id,
          actorName: ctx.self.name,
          jobId: pending.jobId,
          toolName: pending.toolName,
          toolCallId: pending.toolCallId,
        })
      }
      return { state }
    },
  })

  const startTask = (state: S, msg: Extract<M, { type: 'startTask' }>, ctx: Ctx): ActorResult<M, S> => {
    const next: S = {
      ...state,
      workflow: msg.workflow,
      task: msg.task,
      inputs: msg.inputs,
      artifactRoot: msg.artifactRoot,
      dependencyOutputs: msg.dependencyOutputs,
      userId: msg.userId,
      clientId: msg.clientId,
    }
    return loop.startTurn(next, {
      messages: buildMessages(msg.workflow, msg.task, msg.inputs, msg.artifactRoot, msg.dependencyOutputs),
      userId: msg.userId,
      clientId: msg.clientId,
    }, ctx)
  }

  const host: Interceptor<M, S> = (state, msg, ctx, next) => {
    if (msg.type === 'startTask') {
      if (state.loop.phase !== 'idle') return { state, stash: true }
      return startTask(state, msg, ctx)
    }
    return next(state, msg)
  }

  return {
    initialState: () => initialState(tools),
    handler: loop.idle,
    interceptors: [host],
    supervision: { type: 'restart', maxRetries: 1, withinMs: 30_000 },
  }
}
