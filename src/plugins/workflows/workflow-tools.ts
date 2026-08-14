import type { ActorRef, ActorDef, ActorContext } from '../../system/index.ts'
import { ask, defineTool, parseToolArgs, onMessage, onLifecycle } from '../../system/index.ts'
import type { SCRInvokeMsg, SCRReply } from '../../types/scr.ts'
import { WorkflowEventTopic } from './types.ts'
import type {
  Workflow,
  WorkflowTask,
  WorkflowValueSpec,
} from './types.ts'
import type { WorkflowManagerMsg } from './workflow-manager.ts'
import { getWorkflow, listWorkflows, saveWorkflow, updateWorkflow, deleteWorkflow, createWorkflowRun } from './workflow-store.ts'
import { validateWorkflow } from './validation.ts'
import { PersistenceProviderTopic, type PersistenceMsg } from '../../types/persistence.ts'

const valueSpecSchema = {
  type: 'object',
  required: ['type'],
  properties: {
    type: { type: 'string', enum: ['string', 'number', 'boolean', 'object', 'array', 'artifact'] },
    required: { type: 'boolean' },
    description: { type: 'string' },
  },
}


export const listAgentModesTool = defineTool('workflows_agent_modes_list', 'List available specialized agent modes that can be configured on workflow tasks.', {
  type: 'object',
  properties: {},
})

export const listExecutionToolsTool = defineTool('workflows_execution_tools_list', 'List tools that workflow tasks may use during execution.', {
  type: 'object',
  properties: {},
})

export const saveWorkflowTool = defineTool('workflows_save', 'Save an accepted workflow. Requires title, goal, summary, and tasks.', {
  type: 'object',
  required: ['goal', 'summary', 'tasks'],
  properties: {
    title: { type: 'string' },
    goal: { type: 'string' },
    summary: { type: 'string' },
    inputs: { type: 'object', additionalProperties: valueSpecSchema },
    outputs: { type: 'object', additionalProperties: valueSpecSchema },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'description', 'validationCriteria', 'dependencies', 'agentMode'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          validationCriteria: { type: 'string' },
          dependencies: { type: 'array', items: { type: 'string' } },
          agentMode: { type: 'string' },
          executionTools: { type: 'array', items: { type: 'string' } },
          outputs: { type: 'object', additionalProperties: valueSpecSchema },
        },
      },
    },
  },
})

export const updateWorkflowTool = defineTool('workflows_update', 'Update an existing workflow by id.', {
  type: 'object',
  required: ['workflowId'],
  properties: {
    workflowId: { type: 'string' },
    title: { type: 'string' },
    goal: { type: 'string' },
    summary: { type: 'string' },
    inputs: { type: 'object', additionalProperties: valueSpecSchema },
    outputs: { type: 'object', additionalProperties: valueSpecSchema },
    tasks: { type: 'array', items: { type: 'object' } },
  },
})

export const deleteWorkflowTool = defineTool('workflows_delete', 'Delete a saved workflow by id.', {
  type: 'object',
  required: ['workflowId'],
  properties: { workflowId: { type: 'string' } },
})

export const listWorkflowsTool = defineTool('workflows_list', 'List saved workflows.', {
  type: 'object',
  properties: {},
})

export const getWorkflowTool = defineTool('workflows_get', 'Read a saved workflow by id.', {
  type: 'object',
  required: ['workflowId'],
  properties: { workflowId: { type: 'string' } },
})

export const showWorkflowGraphTool = defineTool('workflows_graph_show', 'Open the graphical DAG workspace for a workflow by id.', {
  type: 'object',
  required: ['workflowId'],
  properties: {
    workflowId: { type: 'string' },
    runId: { type: 'string' },
  },
})

export const startWorkflowRunTool = defineTool('workflows_run_start', 'Start a new execution run of a saved workflow.', {
  type: 'object',
  required: ['workflowId'],
  properties: {
    workflowId: { type: 'string' },
    inputs: { type: 'object' },
  },
})

export const listWorkflowRunsTool = defineTool('workflows_runs_list', 'List execution runs for workflows.', {
  type: 'object',
  properties: {},
})

export const getWorkflowRunTool = defineTool('workflows_run_get', 'Inspect a workflow execution run by runId.', {
  type: 'object',
  required: ['runId'],
  properties: { runId: { type: 'string' } },
})

export const resumeWorkflowRunTool = defineTool('workflows_run_resume', 'Resume execution of a blocked or failed workflow run.', {
  type: 'object',
  required: ['runId'],
  properties: { runId: { type: 'string' } },
})

const workflowIdArg = (raw: unknown): { ok: true; workflowId: string; runId?: string } | { ok: false; error: string } => {
  const parsed = parseToolArgs(raw, obj => {
    const workflowId = obj.workflowId
    const runId = obj.runId
    return typeof workflowId === 'string' && workflowId.trim()
      ? { workflowId: workflowId.trim(), ...(typeof runId === 'string' && runId.trim() ? { runId: runId.trim() } : {}) }
      : null
  }, 'Missing required argument: workflowId')
  return parsed.ok ? { ok: true, ...parsed.value } : parsed
}

const runIdArg = (raw: unknown): { ok: true; runId: string } | { ok: false; error: string } => {
  const parsed = parseToolArgs(raw, obj => {
    const runId = obj.runId
    return typeof runId === 'string' && runId.trim() ? { runId: runId.trim() } : null
  }, 'Missing required argument: runId')
  return parsed.ok ? { ok: true, runId: parsed.value.runId } : parsed
}

const startWorkflowArg = (raw: unknown): { ok: true; workflowId: string; inputs?: Record<string, unknown> } | { ok: false; error: string } => {
  const parsed = parseToolArgs(raw, obj => {
    const workflowId = obj.workflowId
    const inputs = obj.inputs
    if (typeof workflowId !== 'string' || !workflowId.trim()) return null
    if (inputs !== undefined && (!inputs || typeof inputs !== 'object' || Array.isArray(inputs))) return null
    return { workflowId: workflowId.trim(), ...(inputs !== undefined ? { inputs: inputs as Record<string, unknown> } : {}) }
  }, 'Missing required argument: workflowId')
  return parsed.ok ? { ok: true, ...parsed.value } : parsed
}

const formatWorkflowList = (workflows: Array<{ id: string; title?: string; goal: string; createdAt: string; taskCount: number }>): string =>
  workflows.length
    ? workflows.map(workflow => `- ${workflow.title || workflow.goal} (id: ${workflow.id}, created: ${workflow.createdAt.slice(0, 10)}, tasks: ${workflow.taskCount})`).join('\n')
    : 'No saved workflows found.'

const formatRunList = (runs: Array<{ runId: string; workflowId: string; status: string }>): string =>
  runs.length
    ? runs.map(run => `- ${run.runId} (${run.status}, workflow: ${run.workflowId})`).join('\n')
    : 'No workflow runs found.'

const parseWorkflow = (raw: unknown, userId: string): { ok: true; workflow: Workflow } | { ok: false; error: string } => {
  try {
    const args = (typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {})) as { title?: string; goal?: string; summary?: string; inputs?: Record<string, WorkflowValueSpec>; outputs?: Record<string, WorkflowValueSpec>; tasks?: WorkflowTask[] }
    if (!args.goal || typeof args.goal !== 'string') throw new Error('missing goal')
    if (!args.summary || typeof args.summary !== 'string') throw new Error('missing summary')
    if (!Array.isArray(args.tasks)) throw new Error('missing tasks')
    const title = (typeof args.title === 'string' && args.title.trim()) ? args.title.trim() : args.goal.trim()
    const workflow: Workflow = {
      id: crypto.randomUUID(),
      userId,
      title,
      goal: args.goal,
      context: args.summary,
      createdAt: new Date().toISOString(),
      ...(args.inputs !== undefined ? { inputs: args.inputs } : {}),
      ...(args.outputs !== undefined ? { outputs: args.outputs } : {}),
      tasks: args.tasks,
    }
    const errors = validateWorkflow(workflow)
    if (errors.length) throw new Error(errors.join('; '))
    return { ok: true, workflow }
  } catch (error) {
    return { ok: false, error: `invalid arguments: ${String(error)}` }
  }
}

const parseWorkflowPatch = (raw: unknown): { ok: true; workflowId: string; patch: { title?: string; goal?: string; context?: string; inputs?: Record<string, WorkflowValueSpec>; outputs?: Record<string, WorkflowValueSpec>; tasks?: WorkflowTask[] } } | { ok: false; error: string } => {
  try {
    const args = (typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {})) as { workflowId?: string; title?: string; goal?: string; summary?: string; inputs?: Record<string, WorkflowValueSpec>; outputs?: Record<string, WorkflowValueSpec>; tasks?: WorkflowTask[] }
    if (!args.workflowId || typeof args.workflowId !== 'string') throw new Error('missing workflowId')
    const patch = {
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.goal !== undefined ? { goal: args.goal } : {}),
      ...(args.summary !== undefined ? { context: args.summary } : {}),
      ...(args.inputs !== undefined ? { inputs: args.inputs } : {}),
      ...(args.outputs !== undefined ? { outputs: args.outputs } : {}),
      ...(args.tasks !== undefined ? { tasks: args.tasks } : {}),
    }
    if (!Object.keys(patch).length) throw new Error('provide at least one field to update')
    return { ok: true, workflowId: args.workflowId, patch }
  } catch (error) {
    return { ok: false, error: `invalid arguments: ${String(error)}` }
  }
}

const toolError = (error: string): SCRReply => ({ type: 'error', error })

export type WorkflowToolDeps = {
  workflowRunnerRef: ActorRef<WorkflowManagerMsg>
  ctx: ActorContext<any>
  persistenceRef: ActorRef<PersistenceMsg>
}

export const handleWorkflowTool = async (
  msg: SCRInvokeMsg,
  deps: WorkflowToolDeps
): Promise<SCRReply> => {
  const { workflowRunnerRef, ctx, persistenceRef } = deps
  const userId = ctx.request.userId

  const isListAgentModes = msg.urn.endsWith('agent_modes_list') || msg.urn.endsWith(listAgentModesTool.name)
  const isListExecutionTools = msg.urn.endsWith('execution_tools_list') || msg.urn.endsWith(listExecutionToolsTool.name)
  const isListWorkflows = msg.urn.endsWith('.list') || msg.urn.endsWith('workflows_list') || msg.urn.endsWith('listWorkflows') || msg.urn.endsWith(listWorkflowsTool.name)
  const isSaveWorkflow = msg.urn.endsWith('.save') || msg.urn.endsWith('workflows_save') || msg.urn.endsWith('saveWorkflow') || msg.urn.endsWith(saveWorkflowTool.name)
  const isGetWorkflow = msg.urn.endsWith('.get') || msg.urn.endsWith('workflows_get') || msg.urn.endsWith('getWorkflow') || msg.urn.endsWith(getWorkflowTool.name)
  const isShowWorkflowGraph = msg.urn.endsWith('graph_show') || msg.urn.endsWith('showWorkflowGraph') || msg.urn.endsWith(showWorkflowGraphTool.name)
  const isUpdateWorkflow = msg.urn.endsWith('.update') || msg.urn.endsWith('workflows_update') || msg.urn.endsWith('updateWorkflow') || msg.urn.endsWith(updateWorkflowTool.name)
  const isDeleteWorkflow = msg.urn.endsWith('.delete') || msg.urn.endsWith('workflows_delete') || msg.urn.endsWith('deleteWorkflow') || msg.urn.endsWith(deleteWorkflowTool.name)
  const isStartRun = msg.urn.endsWith('run_start') || msg.urn.endsWith('startWorkflowRun') || msg.urn.endsWith(startWorkflowRunTool.name)
  const isListRuns = msg.urn.endsWith('runs_list') || msg.urn.endsWith('listWorkflowRuns') || msg.urn.endsWith(listWorkflowRunsTool.name)
  const isGetRun = msg.urn.endsWith('run_get') || msg.urn.endsWith('getWorkflowRun') || msg.urn.endsWith(getWorkflowRunTool.name)
  const isResumeRun = msg.urn.endsWith('run_resume') || msg.urn.endsWith('resumeWorkflowRun') || msg.urn.endsWith(resumeWorkflowRunTool.name)

  if (isListAgentModes) {
    const reply = await ask<WorkflowManagerMsg, any>(workflowRunnerRef, replyTo => ({ type: 'listAgentModes', replyTo }), { timeoutMs: 5_000 })
    return reply.ok && 'agentModes' in reply
      ? { type: 'result', output: { text: JSON.stringify(reply.agentModes, null, 2) } }
      : toolError(reply.ok ? 'Unexpected workflow runner response.' : reply.error)
  }

  if (isListExecutionTools) {
    const reply = await ask<WorkflowManagerMsg, any>(workflowRunnerRef, replyTo => ({ type: 'listExecutionTools', replyTo }), { timeoutMs: 5_000 })
    return reply.ok && 'executionTools' in reply
      ? { type: 'result', output: { text: JSON.stringify(reply.executionTools, null, 2) } }
      : toolError(reply.ok ? 'Unexpected workflow runner response.' : reply.error)
  }

  if (isListWorkflows) {
    const workflows = await listWorkflows(persistenceRef, userId)
    return { type: 'result', output: { text: formatWorkflowList(workflows) } }
  }

  if (isSaveWorkflow) {
    const parsed = parseWorkflow(msg.input, userId)
    if (!parsed.ok) return toolError(parsed.error)
    const result = await saveWorkflow(persistenceRef, parsed.workflow)
    if (!result.ok) return toolError(result.error)
    ctx.publish(WorkflowEventTopic, { userId, workflowId: result.data.workflow.id })
    return { type: 'result', output: { text: `Workflow saved - ${result.data.workflow.tasks.length} tasks.` } }
  }

  if (isGetWorkflow || isShowWorkflowGraph) {
    const arg = workflowIdArg(msg.input)
    if (!arg.ok) return toolError(arg.error)
    if (isGetWorkflow) {
      const result = await getWorkflow(persistenceRef, userId, arg.workflowId)
      if (!result.ok) return toolError(result.error)
      return { type: 'result', output: { text: JSON.stringify(result.data.workflow, null, 2) } }
    }
    ctx.publish(WorkflowEventTopic, { userId, workflowId: arg.workflowId, runId: arg.runId })
    return { type: 'result', output: { text: `Opened workflow graph for ${arg.workflowId}.` } }
  }

  if (isUpdateWorkflow) {
    const parsed = parseWorkflowPatch(msg.input)
    if (!parsed.ok) return toolError(parsed.error)
    const result = await updateWorkflow(persistenceRef, userId, parsed.workflowId, parsed.patch)
    if (!result.ok) return toolError(result.error)
    ctx.publish(WorkflowEventTopic, { userId, workflowId: parsed.workflowId })
    return { type: 'result', output: { text: `Workflow ${parsed.workflowId} updated successfully.` } }
  }

  if (isDeleteWorkflow) {
    const arg = workflowIdArg(msg.input)
    if (!arg.ok) return toolError(arg.error)
    const result = await deleteWorkflow(persistenceRef, userId, arg.workflowId)
    if (!result.ok) return toolError(result.error)
    return { type: 'result', output: { text: `Workflow ${arg.workflowId} deleted.` } }
  }

  if (isStartRun) {
    const arg = startWorkflowArg(msg.input)
    if (!arg.ok) return toolError(arg.error)

    const result = await createWorkflowRun(persistenceRef, userId, arg.workflowId, arg.inputs)
    if (!result.ok) return toolError(result.error)
    const { run, workflow } = result.data

    const reply = await ask<WorkflowManagerMsg, any>(
      workflowRunnerRef,
      replyTo => ({
        type: 'start',
        run,
        workflow,
        replyTo,
        permission: ctx.request?.permission,
      }),
      { timeoutMs: 10_000 },
    )

    if (!reply.ok || !('run' in reply)) return toolError(reply.ok ? 'Unexpected workflow runner response.' : reply.error)
    ctx.publish(WorkflowEventTopic, { userId, workflowId: reply.run.workflowId, runId: reply.run.runId })
    if (reply.run.status !== 'running') {
      return { type: 'result', output: { text: JSON.stringify(reply.run, null, 2) } }
    }
    return { type: 'pending', jobId: reply.run.runId, placeholderText: `Workflow run started (runId=${reply.run.runId}).` }
  }

  if (isListRuns) {
    const reply = await ask<WorkflowManagerMsg, any>(workflowRunnerRef, replyTo => ({ type: 'list', userId: userId, replyTo }), { timeoutMs: 5_000 })
    return reply.ok && 'runs' in reply
      ? { type: 'result', output: { text: formatRunList(reply.runs) } }
      : toolError(reply.ok ? 'Unexpected workflow runner response.' : reply.error)
  }

  if (isGetRun || isResumeRun) {
    const arg = runIdArg(msg.input)
    if (!arg.ok) return toolError(arg.error)
    const type = isGetRun ? 'get' : 'resume'
    const reply = await ask<WorkflowManagerMsg, any>(
      workflowRunnerRef,
      replyTo => type === 'get'
        ? { type: 'get', userId: userId, runId: arg.runId, replyTo }
        : { type: 'resume', userId: userId, runId: arg.runId, replyTo },
      { timeoutMs: 10_000 },
    )
    return reply.ok && 'run' in reply
      ? { type: 'result', output: { text: JSON.stringify(reply.run, null, 2) } }
      : toolError(reply.ok ? 'Unexpected workflow runner response.' : reply.error)
  }

  return toolError(`Unknown tool: ${msg.urn}`)
}

type ToolsState = {
  persistenceRef: ActorRef<any> | null
}

type ToolsMsg =
  | SCRInvokeMsg
  | { type: '_persistenceRef'; ref: ActorRef<any> | null }
  | { type: '_done' }



export const WorkflowToolsActor = (options: {
  workflowRunnerRef: ActorRef<WorkflowManagerMsg>
}): ActorDef<ToolsMsg, ToolsState> => ({
  initialState: () => ({ persistenceRef: null }),
  lifecycle: onLifecycle({
    start: (state, context) => {
      context.subscribe(PersistenceProviderTopic, (event) => ({
        type: '_persistenceRef' as const,
        ref: event.ref,
      }))
      return { state }
    }
  }),
  handler: onMessage<ToolsMsg, ToolsState>({
    _persistenceRef: (state, msg) => {
      return { state: { ...state, persistenceRef: msg.ref } }
    },

    invoke: (state, msg, ctx) => {
      if (!state.persistenceRef) {
        msg.replyTo.send({ type: 'error', error: 'Persistence not ready' })
        return { state }
      }
      handleWorkflowTool(msg, {
        workflowRunnerRef: options.workflowRunnerRef,
        ctx,
        persistenceRef: state.persistenceRef
      }).then(
        reply => msg.replyTo.send(reply),
        error => msg.replyTo.send({ type: 'error', error: String(error) }),
      )
      return { state }
    },

    _done: state => ({ state }),
  }),
  supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
})