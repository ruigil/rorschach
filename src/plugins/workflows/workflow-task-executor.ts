import type { ActorContext, ActorDef, ActorRef, ActorResult, Interceptor } from '../../system/index.ts'
import { agentLoop, idleLoopState, onLifecycle } from '../../system/index.ts'
import { ToolRegistrationTopic, type ToolCollection, type ToolMsg } from '../../types/tools.ts'
import type { ApiMessage, LlmProviderMsg } from '../../types/llm.ts'
import type {
  WorkflowRunExecutorMsg,
  WorkflowTaskExecutorMsg,
  WorkflowTask,
  Workflow,
} from './types.ts'

type TaskExecutorState = {
  loop: ReturnType<typeof idleLoopState>
  workflow: Workflow | null
  task: WorkflowTask | null
  dependencySummaries: Record<string, string>
  allowedTools: string[]
  registeredTools: ToolCollection
  tools: ToolCollection
  userId: string
  clientId?: string
}

const initialState = (): TaskExecutorState => ({
  loop: idleLoopState(),
  workflow: null,
  task: null,
  dependencySummaries: {},
  allowedTools: [],
  registeredTools: {},
  tools: {},
  userId: '',
})

const buildMessages = (
  workflow: Workflow,
  task: WorkflowTask,
  dependencySummaries: Record<string, string>,
): ApiMessage[] => [
  {
    role: 'system',
    content: `You execute exactly one workflow task.

Complete the task using only available tools. If the task cannot be completed, explain why it is blocked. When the task is complete, respond with a concise completion summary.

Workflow goal: ${workflow.goal}
Workflow context: ${workflow.context}
Task id: ${task.id}
Task name: ${task.name}
Task description: ${task.description}
Validation criteria: ${task.validationCriteria}
Dependency summaries:
${Object.entries(dependencySummaries).map(([id, summary]) => `- ${id}: ${summary}`).join('\n') || '- none'}`,
  },
  {
    role: 'user',
    content: `Execute workflow task "${task.name}" and finish with a short summary once the validation criteria are satisfied.`,
  },
]

export const WorkflowTaskExecutor = (
  parentRef: ActorRef<WorkflowRunExecutorMsg>,
  llmRef: ActorRef<LlmProviderMsg> | null,
  model: string,
  maxToolLoops: number,
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
        parentRef.send({ type: 'taskCompleted', taskId: state.task.id, summary: finalText || 'Task completed.' })
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
    const allowed = new Set(msg.allowedTools)
    const tools = Object.fromEntries(
      Object.entries(state.registeredTools).filter(([name]) => allowed.has(name)),
    )
    const next: S = {
      ...state,
      workflow: msg.workflow,
      task: msg.task,
      dependencySummaries: msg.dependencySummaries,
      allowedTools: msg.allowedTools,
      tools,
      userId: msg.userId,
      clientId: msg.clientId,
    }
    return loop.startTurn(next, {
      messages: buildMessages(msg.workflow, msg.task, msg.dependencySummaries),
      userId: msg.userId,
      clientId: msg.clientId,
    }, ctx)
  }

  const host: Interceptor<M, S> = (state, msg, ctx, next) => {
    if (msg.type === 'startTask') {
      if (state.loop.phase !== 'idle') return { state, stash: true }
      return startTask(state, msg, ctx)
    }
    if (msg.type === '_toolRegistered') {
      if (!state.allowedTools.includes(msg.name)) return { state }
      return {
        state: {
          ...state,
          registeredTools: {
            ...state.registeredTools,
            [msg.name]: { name: msg.name, schema: msg.schema, ref: msg.ref, mayBeLongRunning: msg.mayBeLongRunning },
          },
          ...(state.allowedTools.includes(msg.name)
            ? { tools: { ...state.tools, [msg.name]: { name: msg.name, schema: msg.schema, ref: msg.ref, mayBeLongRunning: msg.mayBeLongRunning } } }
            : {}),
        },
      }
    }
    if (msg.type === '_toolUnregistered') {
      const { [msg.name]: _oldRegistered, ...registeredTools } = state.registeredTools
      const { [msg.name]: _, ...tools } = state.tools
      return { state: { ...state, registeredTools, tools } }
    }
    return next(state, msg)
  }

  return {
    initialState,
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(ToolRegistrationTopic, event => {
          if ('schema' in event) {
            return {
              type: '_toolRegistered' as const,
              name: event.name,
              schema: event.schema,
              ref: event.ref as ActorRef<ToolMsg>,
              mayBeLongRunning: event.mayBeLongRunning,
            }
          }
          return { type: '_toolUnregistered' as const, name: event.name }
        })
        return { state }
      },
    }),
    handler: loop.idle,
    interceptors: [host],
    supervision: { type: 'restart', maxRetries: 1, withinMs: 30_000 },
  }
}
