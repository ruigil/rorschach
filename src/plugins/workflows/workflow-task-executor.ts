import type { ActorContext, ActorDef, ActorRef, ActorResult, Interceptor } from '../../system/index.ts'
import { agentLoop, defineTool, idleLoopState, parseToolArgs, onLifecycle, ask } from '../../system/index.ts'
import type { ToolCollection, ToolMsg, ToolReply } from '../../types/tools.ts'
import { LlmProviderTopic, type ApiMessage, type LlmProviderMsg } from '../../types/llm.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult, type PObjGetPayload } from '../../types/persistence.ts'
import { AgentRegistrationTopic, type AgentDescriptor } from '../../types/agents.ts'
import type {
  WorkflowRunExecutorMsg,
  WorkflowTaskExecutorMsg,
  WorkflowTask,
  Workflow,
  WorkflowDependencyOutput,
  WorkflowOutputValue,
} from './types.ts'
import { validateOutputValues } from './validation.ts'

export const TOOL_EXECUTOR_DESCRIPTOR: AgentDescriptor = {
  mode: 'tool-executor',
  displayName: 'Tool Executor',
  shortDesc: 'Generic agent responsible for mapping task inputs, executing task tools, and outputting results',
  role: 'tool-executor',
  systemPrompt: `You are a generic workflow tool executor agent.
Your primary role is to execute workflow tasks by invoking available task execution tools.

Task Execution Instructions:
1. Review the workflow task goal, inputs, and dependency outputs.
2. Translate task inputs and dependency outputs into accurate parameter arguments for the declared task execution tools.
3. Invoke the execution tool(s) required to complete the task.
4. When tool execution settles, inspect the results and format declared task outputs.
5. Call complete_workflow_task with a summary and structured outputs matching task output specifications.
6. If a required tool fails or cannot satisfy validation criteria, call block_workflow_task with a clear reason.`,
  internalTools: [], // System control tools (complete/block/read/write) are injected by TaskExecutor
  capabilities: { userVisible: false },
  model: 'default',
  maxToolLoops: 5,
}

type TaskExecutorState = {
  loop: ReturnType<typeof idleLoopState>
  runId: string
  workflow: Workflow | null
  task: WorkflowTask | null
  inputs: Record<string, unknown>
  dependencyOutputs: Record<string, WorkflowDependencyOutput>
  tools: ToolCollection
  userId: string
  terminalSignaled: boolean
  llmRef: ActorRef<LlmProviderMsg> | null
  persistenceRef: ActorRef<any> | null
  descriptors: Record<string, AgentDescriptor>
}

const initialState = (tools: ToolCollection, llmRef: ActorRef<LlmProviderMsg> | null): TaskExecutorState => ({
  loop: idleLoopState(),
  runId: '',
  workflow: null,
  task: null,
  inputs: {},
  dependencyOutputs: {},
  tools,
  userId: '',
  terminalSignaled: false,
  llmRef,
  persistenceRef: null,
  descriptors: {
    [TOOL_EXECUTOR_DESCRIPTOR.mode]: TOOL_EXECUTOR_DESCRIPTOR,
  },
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

export const readArtifactTool = defineTool('read_artifact', 'Read text content of a workflow run artifact from persistence.', {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'Canonical key of the artifact file.' },
    path: { type: 'string', description: 'Path of the artifact file.' },
    root: { type: 'string', description: 'Optional root directory override.' },
  },
})

export const writeArtifactTool = defineTool('write_artifact', 'Write/save text content as a workflow run artifact to persistence.', {
  type: 'object',
  required: ['path', 'content'],
  properties: {
    path: { type: 'string', description: 'Path of the artifact file.' },
    root: { type: 'string', description: 'Optional root directory override (e.g. "documentation"). Defaults to "workflow-runs/<runId>" if omitted.' },
    content: { type: 'string', description: 'The text content to save.' },
    mimeType: { type: 'string', description: 'Optional MIME type of the content.' },
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
  descriptor: AgentDescriptor,
  workflow: Workflow,
  task: WorkflowTask,
  inputs: Record<string, unknown>,
  dependencyOutputs: Record<string, WorkflowDependencyOutput>,
  resumeContext?: string,
): ApiMessage[] => [
  {
    role: 'system',
    content: `${descriptor.systemPrompt}

You execute exactly one workflow task.
Complete the task using available tools.
Do not finish by writing the task result in the assistant message.

When the validation criteria are satisfied, call complete_workflow_task with:
{
  "summary": "short human-readable completion summary",
  "outputs": { The task outputs object must contain only declared task output keys }
}

When the task cannot be completed, call block_workflow_task with:
{
  "reason": "short explanation of what is blocking the task"
}
Artifact rules:
- Reading artifacts: Call read_artifact only if the task description, validation criteria, or dependency outputs require inspecting an artifact stored in persistence. Use the canonical "key" provided in Dependency outputs.
- Writing artifacts: Call write_artifact only if a declared task output has type "artifact". Do not call write_artifact for standard non-artifact outputs.
- Custom root: Specify "root" in write_artifact ONLY if the task description or validation criteria explicitly requires a custom root directory (e.g., root: "documentation"). Otherwise, omit "root" so it defaults automatically to the run directory.
- Output reference: In complete_workflow_task, for declared artifact outputs, return an artifact reference using the canonical key returned by write_artifact, for example { "type": "artifact", "key": "workflow-runs/<runId>/report.html", "mimeType": "text/html" }.

Workflow goal: ${workflow.goal}
Workflow context: ${workflow.context}
Run inputs:
${JSON.stringify(inputs, null, 2)}
Task id: ${task.id}
Task name: ${task.name}
Task description: ${task.description}
Validation criteria: ${task.validationCriteria}
Declaring Agent Mode: ${descriptor.mode}
Declared task outputs:
${JSON.stringify(task.outputs ?? {}, null, 2)}
Dependency outputs:
${JSON.stringify(dependencyOutputs, null, 2)}${resumeContext ? `\nResume context:\n${resumeContext}` : ''}
`,
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
    llmRef: s => s.llmRef,
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
    const descriptor = state.descriptors[msg.task.agentMode]
    if (!descriptor) {
      parentRef.send({
        type: 'taskBlocked',
        taskId: msg.task.id,
        message: `Agent mode '${msg.task.agentMode}' is not registered`,
      })
      return {
        state: {
          ...state,
          runId: msg.runId,
          workflow: msg.workflow,
          task: msg.task,
          inputs: msg.inputs,
          dependencyOutputs: msg.dependencyOutputs,
          userId: msg.userId,
          terminalSignaled: true,
        },
      }
    }

    let externalTaskTools: ToolCollection = {}
    for (const [toolName, tool] of Object.entries(tools)) {
      externalTaskTools[toolName] = tool
    }

    const descriptorInternalTools: ToolCollection = {}
    if (descriptor.internalTools) {
      for (const tool of descriptor.internalTools) {
        descriptorInternalTools[tool.name] = tool
      }
    }

    const finalTools: ToolCollection = {
      ...externalTaskTools,
      ...descriptorInternalTools,
      [completeWorkflowTaskTool.name]: { ...completeWorkflowTaskTool, ref: ctx.self as ActorRef<ToolMsg> },
      [blockWorkflowTaskTool.name]: { ...blockWorkflowTaskTool, ref: ctx.self as ActorRef<ToolMsg> },
      [readArtifactTool.name]: { ...readArtifactTool, ref: ctx.self as ActorRef<ToolMsg> },
      [writeArtifactTool.name]: { ...writeArtifactTool, ref: ctx.self as ActorRef<ToolMsg> },
    }

    const next: S = {
      ...state,
      runId: msg.runId,
      workflow: msg.workflow,
      task: msg.task,
      inputs: msg.inputs,
      dependencyOutputs: msg.dependencyOutputs,
      tools: finalTools,
      userId: msg.userId,
      terminalSignaled: false,
    }
    const messages = msg.history ?? buildMessages(descriptor, msg.workflow, msg.task, msg.inputs, msg.dependencyOutputs)
    return loop.startTurn(next, {
      messages,
      userId: msg.userId,
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

  const invokeArtifactTool = (state: S, msg: Extract<M, { type: 'invoke' }>): ActorResult<M, S> => {
    if (!state.persistenceRef) {
      msg.replyTo.send({ type: 'toolError', error: 'Persistence not ready' })
      return { state }
    }
    if (msg.toolName === readArtifactTool.name) {
      let args: { key?: string; root?: string; path?: string }
      try {
        args = JSON.parse(msg.arguments)
      } catch {
        msg.replyTo.send({ type: 'toolError', error: 'Invalid JSON arguments' })
        return { state }
      }
      const rawPath = args.key ?? (args.root ? `${args.root}/${args.path ?? ''}` : (args.path ? (args.path.startsWith('workflow-runs/') ? args.path : `workflow-runs/${state.runId}/${args.path}`) : ''))
      const canonicalKey = rawPath.replace(/^\/+/, '')
      if (!canonicalKey) {
        msg.replyTo.send({ type: 'toolError', error: 'Missing artifact path or key' })
        return { state }
      }
      const [bucket, ...rest] = canonicalKey.split('/')
      const key = rest.join('/')
      if (!bucket || !key) {
        msg.replyTo.send({ type: 'toolError', error: 'Invalid artifact location' })
        return { state }
      }
      ask<PersistenceMsg, PResult<PObjGetPayload>>(state.persistenceRef, replyTo => ({
        type: 'obj.get',
        bucket,
        key,
        replyTo,
      })).then(
        res => {
          if (!res.ok) {
            msg.replyTo.send({ type: 'toolError', error: res.error })
          } else if (!res.data) {
            msg.replyTo.send({ type: 'toolError', error: 'No data found' })
          } else {
            const text = new TextDecoder().decode(res.data.data)
            msg.replyTo.send({ type: 'toolResult', result: { text } })
          }
        },
        err => msg.replyTo.send({ type: 'toolError', error: String(err) })
      )
      return { state }
    }
    if (msg.toolName === writeArtifactTool.name) {
      let args: { root?: string; path: string; content: string; mimeType?: string }
      try {
        args = JSON.parse(msg.arguments)
      } catch {
        msg.replyTo.send({ type: 'toolError', error: 'Invalid JSON arguments' })
        return { state }
      }
      if (!args.path) {
        msg.replyTo.send({ type: 'toolError', error: 'Missing path' })
        return { state }
      }
      if (args.content === undefined) {
        msg.replyTo.send({ type: 'toolError', error: 'Missing content' })
        return { state }
      }
      const cleanPath = args.path.replace(/^\/+/, '')
      const cleanRoot = args.root?.trim()?.replace(/^\/+/, '')
      const canonicalKey = cleanRoot
        ? `${cleanRoot}/${cleanPath}`
        : `workflow-runs/${state.runId}/${cleanPath}`

      const [bucket, ...rest] = canonicalKey.split('/')
      const key = rest.join('/')
      if (!bucket || !key) {
        msg.replyTo.send({ type: 'toolError', error: 'Invalid artifact location' })
        return { state }
      }

      const data = new TextEncoder().encode(args.content)
      const contentType = args.mimeType || 'text/plain'
      ask<PersistenceMsg, PResult>(state.persistenceRef, replyTo => ({
        type: 'obj.put',
        bucket,
        key,
        data,
        meta: { contentType },
        replyTo,
      })).then(
        res => {
          if (!res.ok) {
            msg.replyTo.send({ type: 'toolError', error: res.error })
          } else {
            msg.replyTo.send({
              type: 'toolResult',
              result: { text: `Artifact saved with key "${canonicalKey}".` },
            })
          }
        },
        err => msg.replyTo.send({ type: 'toolError', error: String(err) })
      )
      return { state }
    }
    return { state }
  }

  const host: Interceptor<M, S> = (state, msg, ctx, next) => {
    if (msg.type === 'startTask') {
      if (state.loop.phase !== 'idle') return { state, stash: true }
      return startTask(state, msg, ctx)
    }
    if (msg.type === 'invoke') {
      if (msg.toolName === completeWorkflowTaskTool.name || msg.toolName === blockWorkflowTaskTool.name) {
        return invokeControlTool(state, msg)
      }
      if (msg.toolName === readArtifactTool.name || msg.toolName === writeArtifactTool.name) {
        return invokeArtifactTool(state, msg)
      }
    }
    if (msg.type === '_llmProvider') {
      return { state: { ...state, llmRef: msg.ref } }
    }
    if (msg.type === '_persistenceRef') {
      return { state: { ...state, persistenceRef: msg.ref } }
    }
    if (msg.type === '_agentRegistration') {
      const event = msg.event
      if (event.type === 'register') {
        return { state: { ...state, descriptors: { ...state.descriptors, [event.descriptor.mode]: event.descriptor } } }
      } else if (event.type === 'unregister') {
        const descriptors = { ...state.descriptors }
        delete descriptors[event.mode]
        return { state: { ...state, descriptors } }
      }
    }
    return next(state, msg)
  }

  return {
    initialState: () => initialState(tools, llmRef),
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(LlmProviderTopic, event => ({ type: '_llmProvider' as const, ref: event.ref }))
        ctx.subscribe(PersistenceProviderTopic, event => ({ type: '_persistenceRef' as const, ref: event.ref }))
        ctx.subscribe(AgentRegistrationTopic, event => ({ type: '_agentRegistration' as const, event }))
        return { state }
      },
    }),
    handler: loop.idle,
    interceptors: [host],
    supervision: { type: 'restart', maxRetries: 1, withinMs: 30_000 },
  }
}

