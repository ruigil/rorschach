import type { ActorContext, ActorDef, ActorRef, ActorResult, Interceptor } from '../../system/index.ts'
import { agentLoop, defineTool, idleLoopState, parseToolArgs } from '../../system/index.ts'
import type { ToolCollection, ToolMsg, ToolReply } from '../../types/tools.ts'
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
  terminalSignaled: boolean
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
  terminalSignaled: false,
})

export const completeWorkflowTaskTool = defineTool('complete_workflow_task', 'Complete the current workflow task with validated structured outputs.', {
  type: 'object',
  required: ['summary', 'outputs'],
  properties: {
    summary: { type: 'string' },
    outputs: { type: 'object' },
  },
})

export const blockWorkflowTaskTool = defineTool('block_workflow_task', 'Mark the current workflow task blocked with a short reason.', {
  type: 'object',
  required: ['reason'],
  properties: {
    reason: { type: 'string' },
  },
})

export const parseTaskCompletionArgs = (
  task: WorkflowTask,
  rawArgs: string,
): { ok: true; summary: string; outputs: Record<string, WorkflowOutputValue> } | { ok: false; error: string } => {
  const parsed = parseToolArgs(rawArgs, obj => {
    const summary = obj.summary
    const outputs = obj.outputs
    if (typeof summary !== 'string' || !summary.trim()) return null
    if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return null
    return { summary: summary.trim(), outputs: outputs as Record<string, unknown> }
  }, 'complete_workflow_task requires non-empty summary and outputs object')
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const validated = validateOutputValues(`task ${task.id}`, task.outputs, parsed.value.outputs)
  if (!validated.ok) return validated
  return { ok: true, summary: parsed.value.summary, outputs: validated.values }
}

export const parseTaskBlockArgs = (
  rawArgs: string,
): { ok: true; reason: string } | { ok: false; error: string } => {
  const parsed = parseToolArgs(rawArgs, obj => {
    const reason = obj.reason
    return typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : null
  }, 'block_workflow_task requires non-empty reason')
  return parsed.ok ? { ok: true, reason: parsed.value.reason } : parsed
}

const buildMessages = (
  workflow: Workflow,
  task: WorkflowTask,
  inputs: Record<string, unknown>,
  artifactRoot: string,
  dependencyOutputs: Record<string, WorkflowDependencyOutput>,
  resumeContext?: string,
): ApiMessage[] => [
  {
    role: 'system',
    content: `You execute exactly one workflow task.

Complete the task using only available tools.

Do not finish by writing the task result in the assistant message.

When the validation criteria are satisfied, call complete_workflow_task with:
{
  "summary": "short human-readable completion summary",
  "outputs": {}
}

When the task cannot be completed, call block_workflow_task with:
{
  "reason": "short explanation of what is blocking the task"
}

The outputs object must contain only declared task output keys. Required outputs must be present. If an output is an artifact, return either a run-local artifact reference after writing under artifactRoot, for example { "type": "artifact", "path": "generated-page.html", "mimeType": "text/html" }, or a public URL artifact reference returned by a tool, for example { "type": "artifact", "url": "generated/image.png", "mimeType": "image/png" }. Do not inline large generated files into JSON outputs.

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
${JSON.stringify(dependencyOutputs, null, 2)}${resumeContext ? `\nResume context:\n${resumeContext}` : ''}`,
  },
  {
    role: 'user',
    content: `Execute workflow task "${task.name}". When complete, call complete_workflow_task. If blocked, call block_workflow_task.`,
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
    onComplete: (state) => {
      if (state.task && !state.terminalSignaled) {
        parentRef.send({
          type: 'taskFailed',
          taskId: state.task.id,
          error: 'Task ended without calling complete_workflow_task or block_workflow_task.',
        })
      }
      return { state }
    },
    onError: (state, err) => {
      if (state.task && !state.terminalSignaled) {
        const error = err.kind === 'loopLimit'
          ? `Tool loop limit reached. ${err.finalText}`.trim()
          : String(err.error)
        parentRef.send({ type: 'taskFailed', taskId: state.task.id, error })
      }
      return { state }
    },
    onToolPending: (state, pending, ctx) => {
      if (state.task) {
        const assistantToolCalls = state.loop.turn.pendingBatch?.calls.map(c => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments }
        }))
        const assistantMsg = { role: 'assistant' as const, content: null, tool_calls: assistantToolCalls }
        const history = [
          ...(state.loop.turn.turnMessages ?? []),
          assistantMsg
        ]

        parentRef.send({
          type: 'taskWaiting',
          taskId: state.task.id,
          actorName: ctx.self.name,
          jobId: pending.jobId,
          toolName: pending.toolName,
          toolCallId: pending.toolCallId,
          history,
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
      tools: {
        ...tools,
        [completeWorkflowTaskTool.name]: { ...completeWorkflowTaskTool, ref: ctx.self as ActorRef<ToolMsg> },
        [blockWorkflowTaskTool.name]: { ...blockWorkflowTaskTool, ref: ctx.self as ActorRef<ToolMsg> },
      },
      userId: msg.userId,
      clientId: msg.clientId,
      terminalSignaled: false,
    }
    const messages = msg.history ?? buildMessages(msg.workflow, msg.task, msg.inputs, msg.artifactRoot, msg.dependencyOutputs)
    return loop.startTurn(next, {
      messages,
      userId: msg.userId,
      clientId: msg.clientId,
    }, ctx)
  }

  const invokeControlTool = (state: S, msg: Extract<M, { type: 'invoke' }>): ActorResult<M, S> => {
    if (!state.task) {
      msg.replyTo.send({ type: 'toolError', error: 'No workflow task is active.' })
      return { state }
    }
    if (msg.toolName === completeWorkflowTaskTool.name) {
      const parsed = parseTaskCompletionArgs(state.task, msg.arguments)
      if (!parsed.ok) {
        msg.replyTo.send({ type: 'toolError', error: parsed.error })
        return { state }
      }
      parentRef.send({ type: 'taskCompleted', taskId: state.task.id, summary: parsed.summary, outputs: parsed.outputs })
      const reply: ToolReply = { type: 'toolResult', result: { text: 'Task completed.' } }
      msg.replyTo.send(reply)
      return { state: { ...state, terminalSignaled: true } }
    }
    if (msg.toolName === blockWorkflowTaskTool.name) {
      const parsed = parseTaskBlockArgs(msg.arguments)
      if (!parsed.ok) {
        msg.replyTo.send({ type: 'toolError', error: parsed.error })
        return { state }
      }
      parentRef.send({ type: 'taskBlocked', taskId: state.task.id, message: parsed.reason })
      const reply: ToolReply = { type: 'toolResult', result: { text: 'Task blocked.' } }
      msg.replyTo.send(reply)
      return { state: { ...state, terminalSignaled: true } }
    }
    msg.replyTo.send({ type: 'toolError', error: `Unknown workflow task control tool: ${msg.toolName}` })
    return { state }
  }

  const host: Interceptor<M, S> = (state, msg, ctx, next) => {
    if (msg.type === 'startTask') {
      if (state.loop.phase !== 'idle') return { state, stash: true }
      return startTask(state, msg, ctx)
    }
    if (msg.type === 'invoke' && (msg.toolName === completeWorkflowTaskTool.name || msg.toolName === blockWorkflowTaskTool.name)) {
      return invokeControlTool(state, msg)
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
