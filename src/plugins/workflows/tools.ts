import type { ActorRef } from '../../system/index.ts'
import { ask, defineTool, parseToolArgs } from '../../system/index.ts'
import type { ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import type {
  Workflow,
  WorkflowRunnerMsg,
  WorkflowRunnerReply,
  WorkflowTask,
  WorkflowValueSpec,
} from './types.ts'
import { getWorkflow, getWorkflowGraph, listWorkflows, saveWorkflow, updateWorkflow, deleteWorkflow } from './workflow-store.ts'
import { validateWorkflow } from './validation.ts'

const valueSpecSchema = {
  type: 'object',
  required: ['type'],
  properties: {
    type: { type: 'string', enum: ['string', 'number', 'boolean', 'object', 'array', 'artifact'] },
    required: { type: 'boolean' },
    description: { type: 'string' },
  },
}

export const listExecutionToolsTool = defineTool('list_execution_tools', 'List tools that workflow tasks may use during execution.', {
  type: 'object',
  properties: {},
})

export const saveWorkflowTool = defineTool('save_workflow', 'Save an accepted workflow. Requires goal, summary, executionTools, and tasks.', {
  type: 'object',
  required: ['goal', 'summary', 'executionTools', 'tasks'],
  properties: {
    goal: { type: 'string' },
    summary: { type: 'string' },
    executionTools: { type: 'array', items: { type: 'string' } },
    inputs: { type: 'object', additionalProperties: valueSpecSchema },
    outputs: { type: 'object', additionalProperties: valueSpecSchema },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'description', 'validationCriteria', 'dependencies'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          validationCriteria: { type: 'string' },
          dependencies: { type: 'array', items: { type: 'string' } },
          outputs: { type: 'object', additionalProperties: valueSpecSchema },
        },
      },
    },
  },
})

export const updateWorkflowTool = defineTool('update_workflow', 'Update an existing workflow by id.', {
  type: 'object',
  required: ['workflowId'],
  properties: {
    workflowId: { type: 'string' },
    goal: { type: 'string' },
    summary: { type: 'string' },
    executionTools: { type: 'array', items: { type: 'string' } },
    inputs: { type: 'object', additionalProperties: valueSpecSchema },
    outputs: { type: 'object', additionalProperties: valueSpecSchema },
    tasks: { type: 'array', items: { type: 'object' } },
  },
})

export const deleteWorkflowTool = defineTool('delete_workflow', 'Delete a saved workflow by id.', {
  type: 'object',
  required: ['workflowId'],
  properties: { workflowId: { type: 'string' } },
})

export const listWorkflowsTool = defineTool('list_workflows', 'List saved workflows.', {
  type: 'object',
  properties: {},
})

export const getWorkflowTool = defineTool('get_workflow', 'Read a saved workflow by id.', {
  type: 'object',
  required: ['workflowId'],
  properties: { workflowId: { type: 'string' } },
})

export const showWorkflowGraphTool = defineTool('show_workflow_graph', 'Open the graphical DAG workspace for a workflow by id.', {
  type: 'object',
  required: ['workflowId'],
  properties: {
    workflowId: { type: 'string' },
    runId: { type: 'string' },
  },
})

export const startWorkflowRunTool = defineTool('start_workflow_run', 'Start executing a saved workflow. Returns a background workflow run job when execution starts, or the run state if it blocks immediately.', {
  type: 'object',
  required: ['workflowId'],
  properties: {
    workflowId: { type: 'string' },
    inputs: { type: 'object' },
  },
})

export const listWorkflowRunsTool = defineTool('list_workflow_runs', 'List workflow runs for the current user.', {
  type: 'object',
  properties: {},
})

export const getWorkflowRunTool = defineTool('get_workflow_run', 'Read workflow run state by run id.', {
  type: 'object',
  required: ['runId'],
  properties: { runId: { type: 'string' } },
})

export const resumeWorkflowRunTool = defineTool('resume_workflow_run', 'Resume a missing-job-blocked workflow run by run id.', {
  type: 'object',
  required: ['runId'],
  properties: { runId: { type: 'string' } },
})

export const workflowControlTools = [
  listExecutionToolsTool,
  saveWorkflowTool,
  updateWorkflowTool,
  deleteWorkflowTool,
  listWorkflowsTool,
  getWorkflowTool,
  showWorkflowGraphTool,
  startWorkflowRunTool,
  listWorkflowRunsTool,
  getWorkflowRunTool,
  resumeWorkflowRunTool,
]

const workflowControlToolNames = new Set(workflowControlTools.map(tool => tool.name))

export const isWorkflowControlTool = (name: string): boolean => workflowControlToolNames.has(name)

const workflowIdArg = (raw: string): { ok: true; workflowId: string; runId?: string } | { ok: false; error: string } => {
  const parsed = parseToolArgs(raw, obj => {
    const workflowId = obj.workflowId
    const runId = obj.runId
    return typeof workflowId === 'string' && workflowId.trim()
      ? { workflowId: workflowId.trim(), ...(typeof runId === 'string' && runId.trim() ? { runId: runId.trim() } : {}) }
      : null
  }, 'Missing required argument: workflowId')
  return parsed.ok ? { ok: true, ...parsed.value } : parsed
}

const runIdArg = (raw: string): { ok: true; runId: string } | { ok: false; error: string } => {
  const parsed = parseToolArgs(raw, obj => {
    const runId = obj.runId
    return typeof runId === 'string' && runId.trim() ? { runId: runId.trim() } : null
  }, 'Missing required argument: runId')
  return parsed.ok ? { ok: true, runId: parsed.value.runId } : parsed
}

const startWorkflowArg = (raw: string): { ok: true; workflowId: string; inputs?: Record<string, unknown> } | { ok: false; error: string } => {
  const parsed = parseToolArgs(raw, obj => {
    const workflowId = obj.workflowId
    const inputs = obj.inputs
    if (typeof workflowId !== 'string' || !workflowId.trim()) return null
    if (inputs !== undefined && (!inputs || typeof inputs !== 'object' || Array.isArray(inputs))) return null
    return { workflowId: workflowId.trim(), ...(inputs !== undefined ? { inputs: inputs as Record<string, unknown> } : {}) }
  }, 'Missing required argument: workflowId')
  return parsed.ok ? { ok: true, ...parsed.value } : parsed
}

const formatWorkflowList = (workflows: Array<{ id: string; goal: string; createdAt: string; taskCount: number }>): string =>
  workflows.length
    ? workflows.map(workflow => `- ${workflow.goal} (id: ${workflow.id}, created: ${workflow.createdAt.slice(0, 10)}, tasks: ${workflow.taskCount})`).join('\n')
    : 'No saved workflows found.'

const formatRunList = (runs: Array<{ runId: string; workflowId: string; status: string }>): string =>
  runs.length
    ? runs.map(run => `- ${run.runId} (${run.status}, workflow: ${run.workflowId})`).join('\n')
    : 'No workflow runs found.'

const parseWorkflow = (raw: string, userId: string): { ok: true; workflow: Workflow } | { ok: false; error: string } => {
  try {
    const args = JSON.parse(raw) as { goal?: string; summary?: string; executionTools?: string[]; inputs?: Record<string, WorkflowValueSpec>; outputs?: Record<string, WorkflowValueSpec>; tasks?: WorkflowTask[] }
    if (!args.goal || typeof args.goal !== 'string') throw new Error('missing goal')
    if (!args.summary || typeof args.summary !== 'string') throw new Error('missing summary')
    if (!Array.isArray(args.executionTools) || !args.executionTools.every(item => typeof item === 'string')) throw new Error('missing executionTools')
    if (!Array.isArray(args.tasks)) throw new Error('missing tasks')
    const workflow: Workflow = {
      id: crypto.randomUUID(),
      userId,
      goal: args.goal,
      context: args.summary,
      createdAt: new Date().toISOString(),
      executionTools: args.executionTools,
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

const parseWorkflowPatch = (raw: string): { ok: true; workflowId: string; patch: { goal?: string; context?: string; executionTools?: string[]; inputs?: Record<string, WorkflowValueSpec>; outputs?: Record<string, WorkflowValueSpec>; tasks?: WorkflowTask[] } } | { ok: false; error: string } => {
  try {
    const args = JSON.parse(raw) as { workflowId?: string; goal?: string; summary?: string; executionTools?: string[]; inputs?: Record<string, WorkflowValueSpec>; outputs?: Record<string, WorkflowValueSpec>; tasks?: WorkflowTask[] }
    if (!args.workflowId || typeof args.workflowId !== 'string') throw new Error('missing workflowId')
    const patch = {
      ...(args.goal !== undefined ? { goal: args.goal } : {}),
      ...(args.summary !== undefined ? { context: args.summary } : {}),
      ...(args.executionTools !== undefined ? { executionTools: args.executionTools } : {}),
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

export type WorkflowToolDeps = {
  workflowsDir: string
  workflowRunnerRef: ActorRef<WorkflowRunnerMsg>
  publishGraph: (clientId: string | undefined, workflowId: string, runId?: string) => void
}

const toolError = (error: string): ToolReply => ({ type: 'toolError', error })

export const handleWorkflowTool = async (msg: ToolInvokeMsg, deps: WorkflowToolDeps): Promise<ToolReply> => {
  const { workflowsDir, workflowRunnerRef, publishGraph } = deps

  if (msg.toolName === listExecutionToolsTool.name) {
    const reply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(workflowRunnerRef, replyTo => ({ type: 'listExecutionTools', replyTo }), { timeoutMs: 5_000 })
    return reply.ok && 'executionTools' in reply
      ? { type: 'toolResult', result: { text: JSON.stringify(reply.executionTools, null, 2) } }
      : toolError(reply.ok ? 'Unexpected workflow runner response.' : reply.error)
  }

  if (msg.toolName === listWorkflowsTool.name) {
    const workflows = await listWorkflows(workflowsDir, msg.userId)
    return { type: 'toolResult', result: { text: formatWorkflowList(workflows) } }
  }

  if (msg.toolName === saveWorkflowTool.name) {
    const parsed = parseWorkflow(msg.arguments, msg.userId)
    if (!parsed.ok) return toolError(parsed.error)
    const result = await saveWorkflow(workflowsDir, parsed.workflow)
    if (!result.ok) return toolError(result.error)
    publishGraph(msg.clientId, result.data.workflow.id)
    return { type: 'toolResult', result: { text: `Workflow saved to ${result.data.filepath} - ${result.data.workflow.tasks.length} tasks.` } }
  }

  if (msg.toolName === getWorkflowTool.name || msg.toolName === showWorkflowGraphTool.name) {
    const arg = workflowIdArg(msg.arguments)
    if (!arg.ok) return toolError(arg.error)
    if (msg.toolName === getWorkflowTool.name) {
      const result = await getWorkflow(workflowsDir, msg.userId, arg.workflowId)
      if (!result.ok) return toolError(result.error)
      return { type: 'toolResult', result: { text: JSON.stringify(result.data.workflow, null, 2) } }
    }
    publishGraph(msg.clientId, arg.workflowId, arg.runId)
    return { type: 'toolResult', result: { text: `Opened workflow graph for ${arg.workflowId}.` } }
  }

  if (msg.toolName === updateWorkflowTool.name) {
    const parsed = parseWorkflowPatch(msg.arguments)
    if (!parsed.ok) return toolError(parsed.error)
    const result = await updateWorkflow(workflowsDir, msg.userId, parsed.workflowId, parsed.patch)
    if (!result.ok) return toolError(result.error)
    return { type: 'toolResult', result: { text: `Workflow ${parsed.workflowId} updated successfully.` } }
  }

  if (msg.toolName === deleteWorkflowTool.name) {
    const arg = workflowIdArg(msg.arguments)
    if (!arg.ok) return toolError(arg.error)
    const result = await deleteWorkflow(workflowsDir, msg.userId, arg.workflowId)
    if (!result.ok) return toolError(result.error)
    return { type: 'toolResult', result: { text: `Workflow ${arg.workflowId} deleted.` } }
  }

  if (msg.toolName === startWorkflowRunTool.name) {
    const arg = startWorkflowArg(msg.arguments)
    if (!arg.ok) return toolError(arg.error)
    const reply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(workflowRunnerRef, replyTo => ({ type: 'start', userId: msg.userId, clientId: msg.clientId, workflowId: arg.workflowId, inputs: arg.inputs, replyTo }), { timeoutMs: 10_000 })
    if (!reply.ok || !('run' in reply)) return toolError(reply.ok ? 'Unexpected workflow runner response.' : reply.error)
    publishGraph(msg.clientId, reply.run.workflowId, reply.run.runId)
    if (reply.run.status !== 'running') {
      return { type: 'toolResult', result: { text: JSON.stringify(reply.run, null, 2) } }
    }
    return { type: 'toolPending', jobId: reply.run.runId, placeholderText: `Workflow run started (runId=${reply.run.runId}).` }
  }

  if (msg.toolName === listWorkflowRunsTool.name) {
    const reply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(workflowRunnerRef, replyTo => ({ type: 'list', userId: msg.userId, replyTo }), { timeoutMs: 5_000 })
    return reply.ok && 'runs' in reply
      ? { type: 'toolResult', result: { text: formatRunList(reply.runs) } }
      : toolError(reply.ok ? 'Unexpected workflow runner response.' : reply.error)
  }

  if ([getWorkflowRunTool.name, resumeWorkflowRunTool.name].includes(msg.toolName)) {
    const arg = runIdArg(msg.arguments)
    if (!arg.ok) return toolError(arg.error)
    const type = msg.toolName === getWorkflowRunTool.name ? 'get' : 'resume'
    const reply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(
      workflowRunnerRef,
      replyTo => type === 'get'
        ? { type: 'get', userId: msg.userId, runId: arg.runId, replyTo }
        : { type: 'resume', userId: msg.userId, runId: arg.runId, replyTo },
      { timeoutMs: 10_000 },
    )
    return reply.ok && 'run' in reply
      ? { type: 'toolResult', result: { text: JSON.stringify(reply.run, null, 2) } }
      : toolError(reply.ok ? 'Unexpected workflow runner response.' : reply.error)
  }

  return toolError(`Unknown tool: ${msg.toolName}`)
}