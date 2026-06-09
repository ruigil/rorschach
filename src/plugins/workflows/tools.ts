import type { ActorDef, ActorRef } from '../../system/index.ts'
import { ask, defineTool, onLifecycle, onMessage, parseToolArgs } from '../../system/index.ts'
import { OutboundMessageTopic } from '../../types/events.ts'
import { ToolRegistrationTopic, type ToolReply } from '../../types/tools.ts'
import type {
  ExecutionToolSummary,
  Workflow,
  WorkflowRunnerMsg,
  WorkflowRunnerReply,
  WorkflowStoreMsg,
  WorkflowStoreReply,
  WorkflowTask,
  WorkflowToolsMsg,
} from './types.ts'

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

export const startWorkflowRunTool = defineTool('start_workflow_run', 'Start executing a saved workflow. Returns a background workflow run job.', {
  type: 'object',
  required: ['workflowId'],
  properties: { workflowId: { type: 'string' } },
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

export const pauseWorkflowRunTool = defineTool('pause_workflow_run', 'Pause a running workflow run by run id.', {
  type: 'object',
  required: ['runId'],
  properties: { runId: { type: 'string' } },
})

export const resumeWorkflowRunTool = defineTool('resume_workflow_run', 'Resume a paused or missing-job-blocked workflow run by run id.', {
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
  pauseWorkflowRunTool,
  resumeWorkflowRunTool,
]

const workflowControlToolNames = new Set(workflowControlTools.map(tool => tool.name))

const replyError = (replyTo: ActorRef<ToolReply>, error: string): void => {
  replyTo.send({ type: 'toolError', error })
}

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
    const args = JSON.parse(raw) as { goal?: string; summary?: string; executionTools?: string[]; tasks?: WorkflowTask[] }
    if (!args.goal || typeof args.goal !== 'string') throw new Error('missing goal')
    if (!args.summary || typeof args.summary !== 'string') throw new Error('missing summary')
    if (!Array.isArray(args.executionTools) || !args.executionTools.every(item => typeof item === 'string')) throw new Error('missing executionTools')
    if (!Array.isArray(args.tasks)) throw new Error('missing tasks')
    return {
      ok: true,
      workflow: {
        id: crypto.randomUUID(),
        userId,
        goal: args.goal,
        context: args.summary,
        createdAt: new Date().toISOString(),
        executionTools: args.executionTools,
        tasks: args.tasks,
      },
    }
  } catch (error) {
    return { ok: false, error: `invalid arguments: ${String(error)}` }
  }
}

const parseWorkflowPatch = (raw: string): { ok: true; workflowId: string; patch: { goal?: string; context?: string; executionTools?: string[]; tasks?: WorkflowTask[] } } | { ok: false; error: string } => {
  try {
    const args = JSON.parse(raw) as { workflowId?: string; goal?: string; summary?: string; executionTools?: string[]; tasks?: WorkflowTask[] }
    if (!args.workflowId || typeof args.workflowId !== 'string') throw new Error('missing workflowId')
    const patch = {
      ...(args.goal !== undefined ? { goal: args.goal } : {}),
      ...(args.summary !== undefined ? { context: args.summary } : {}),
      ...(args.executionTools !== undefined ? { executionTools: args.executionTools } : {}),
      ...(args.tasks !== undefined ? { tasks: args.tasks } : {}),
    }
    if (!Object.keys(patch).length) throw new Error('provide at least one field to update')
    return { ok: true, workflowId: args.workflowId, patch }
  } catch (error) {
    return { ok: false, error: `invalid arguments: ${String(error)}` }
  }
}

export const WorkflowTools = (
  workflowStoreRef: ActorRef<WorkflowStoreMsg>,
  workflowRunnerRef: ActorRef<WorkflowRunnerMsg>,
): ActorDef<WorkflowToolsMsg, { executionTools: Record<string, ExecutionToolSummary> }> => ({
  initialState: { executionTools: {} },
  lifecycle: onLifecycle({
    start: (state, ctx) => {
      ctx.subscribe(ToolRegistrationTopic, event => {
        if (workflowControlToolNames.has(event.name)) return null
        if ('schema' in event) {
          return {
            type: '_toolRegistered' as const,
            name: event.name,
            summary: {
              name: event.name,
              description: event.schema.function.description,
              mayBeLongRunning: event.mayBeLongRunning,
            },
          }
        }
        return { type: '_toolUnregistered' as const, name: event.name }
      })
      return { state }
    },
  }),
  handler: onMessage<WorkflowToolsMsg, { executionTools: Record<string, ExecutionToolSummary> }>({
    _done: state => ({ state }),
    _reply: (state, msg) => {
      msg.replyTo.send(msg.reply)
      return { state }
    },
    _toolRegistered: (state, msg) => ({
      state: { ...state, executionTools: { ...state.executionTools, [msg.name]: msg.summary } },
    }),
    _toolUnregistered: (state, msg) => {
      const { [msg.name]: _, ...executionTools } = state.executionTools
      return { state: { ...state, executionTools } }
    },
    invoke: (state, msg, ctx) => {
      if (msg.toolName === listExecutionToolsTool.name) {
        msg.replyTo.send({ type: 'toolResult', result: { text: JSON.stringify(Object.values(state.executionTools), null, 2) } })
        return { state }
      }

      if (msg.toolName === listWorkflowsTool.name) {
        ctx.pipeToSelf(
          ask<WorkflowStoreMsg, WorkflowStoreReply>(workflowStoreRef, replyTo => ({ type: 'list', userId: msg.userId, replyTo }), { timeoutMs: 5_000 }),
          reply => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: reply.ok && 'workflows' in reply ? { type: 'toolResult' as const, result: { text: formatWorkflowList(reply.workflows) } } : { type: 'toolError' as const, error: reply.ok ? 'Unexpected workflow store response.' : reply.error } }),
          error => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: { type: 'toolError' as const, error: String(error) } }),
        )
        return { state }
      }

      if (msg.toolName === saveWorkflowTool.name) {
        const parsed = parseWorkflow(msg.arguments, msg.userId)
        if (!parsed.ok) {
          replyError(msg.replyTo, parsed.error)
          return { state }
        }
        ctx.pipeToSelf(
          ask<WorkflowStoreMsg, WorkflowStoreReply>(workflowStoreRef, replyTo => ({ type: 'save', workflow: parsed.workflow, replyTo }), { timeoutMs: 5_000 }),
          reply => {
            if (!reply.ok || !('workflow' in reply)) return { type: '_reply' as const, replyTo: msg.replyTo, reply: { type: 'toolError' as const, error: reply.ok ? 'Unexpected workflow store response.' : reply.error } }
            if (msg.clientId) ctx.publish(OutboundMessageTopic, { clientId: msg.clientId, text: JSON.stringify({ type: 'workflowGraph', workflowId: reply.workflow.id }) })
            return { type: '_reply' as const, replyTo: msg.replyTo, reply: { type: 'toolResult' as const, result: { text: `Workflow saved to ${reply.filepath} - ${reply.workflow.tasks.length} tasks.` } } }
          },
          error => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: { type: 'toolError' as const, error: String(error) } }),
        )
        return { state }
      }

      if (msg.toolName === getWorkflowTool.name || msg.toolName === showWorkflowGraphTool.name) {
        const arg = workflowIdArg(msg.arguments)
        if (!arg.ok) {
          replyError(msg.replyTo, arg.error)
          return { state }
        }
        if (msg.toolName === getWorkflowTool.name) {
          ctx.pipeToSelf(
            ask<WorkflowStoreMsg, WorkflowStoreReply>(workflowStoreRef, replyTo => ({ type: 'get', userId: msg.userId, workflowId: arg.workflowId, replyTo }), { timeoutMs: 5_000 }),
            reply => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: reply.ok && 'workflow' in reply ? { type: 'toolResult' as const, result: { text: JSON.stringify(reply.workflow, null, 2) } } : { type: 'toolError' as const, error: reply.ok ? 'Unexpected workflow store response.' : reply.error } }),
            error => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: { type: 'toolError' as const, error: String(error) } }),
          )
          return { state }
        }
        if (msg.clientId) ctx.publish(OutboundMessageTopic, { clientId: msg.clientId, text: JSON.stringify({ type: 'workflowGraph', workflowId: arg.workflowId, ...(arg.runId ? { runId: arg.runId } : {}) }) })
        msg.replyTo.send({ type: 'toolResult', result: { text: `Opened workflow graph for ${arg.workflowId}.` } })
        return { state }
      }

      if (msg.toolName === updateWorkflowTool.name) {
        const parsed = parseWorkflowPatch(msg.arguments)
        if (!parsed.ok) {
          replyError(msg.replyTo, parsed.error)
          return { state }
        }
        ctx.pipeToSelf(
          ask<WorkflowStoreMsg, WorkflowStoreReply>(workflowStoreRef, replyTo => ({ type: 'update', userId: msg.userId, workflowId: parsed.workflowId, patch: parsed.patch, replyTo }), { timeoutMs: 5_000 }),
          reply => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: reply.ok && 'updated' in reply ? { type: 'toolResult' as const, result: { text: `Workflow ${parsed.workflowId} updated successfully.` } } : { type: 'toolError' as const, error: reply.ok ? 'Unexpected workflow store response.' : reply.error } }),
          error => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: { type: 'toolError' as const, error: String(error) } }),
        )
        return { state }
      }

      if (msg.toolName === deleteWorkflowTool.name) {
        const arg = workflowIdArg(msg.arguments)
        if (!arg.ok) {
          replyError(msg.replyTo, arg.error)
          return { state }
        }
        ctx.pipeToSelf(
          ask<WorkflowStoreMsg, WorkflowStoreReply>(workflowStoreRef, replyTo => ({ type: 'delete', userId: msg.userId, workflowId: arg.workflowId, replyTo }), { timeoutMs: 5_000 }),
          reply => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: reply.ok && 'deleted' in reply ? { type: 'toolResult' as const, result: { text: `Workflow ${arg.workflowId} deleted.` } } : { type: 'toolError' as const, error: reply.ok ? 'Unexpected workflow store response.' : reply.error } }),
          error => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: { type: 'toolError' as const, error: String(error) } }),
        )
        return { state }
      }

      if (msg.toolName === startWorkflowRunTool.name) {
        const arg = workflowIdArg(msg.arguments)
        if (!arg.ok) {
          replyError(msg.replyTo, arg.error)
          return { state }
        }
        ctx.pipeToSelf(
          ask<WorkflowRunnerMsg, WorkflowRunnerReply>(workflowRunnerRef, replyTo => ({ type: 'start', userId: msg.userId, clientId: msg.clientId, workflowId: arg.workflowId, replyTo }), { timeoutMs: 10_000 }),
          reply => {
            if (!reply.ok || !('run' in reply)) return { type: '_reply' as const, replyTo: msg.replyTo, reply: { type: 'toolError' as const, error: reply.ok ? 'Unexpected workflow runner response.' : reply.error } }
            if (msg.clientId) ctx.publish(OutboundMessageTopic, { clientId: msg.clientId, text: JSON.stringify({ type: 'workflowGraph', workflowId: reply.run.workflowId, runId: reply.run.runId }) })
            return { type: '_reply' as const, replyTo: msg.replyTo, reply: { type: 'toolPending' as const, jobId: reply.run.runId, placeholderText: `Workflow run started (runId=${reply.run.runId}).` } }
          },
          error => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: { type: 'toolError' as const, error: String(error) } }),
        )
        return { state }
      }

      if (msg.toolName === listWorkflowRunsTool.name) {
        ctx.pipeToSelf(
          ask<WorkflowRunnerMsg, WorkflowRunnerReply>(workflowRunnerRef, replyTo => ({ type: 'list', userId: msg.userId, replyTo }), { timeoutMs: 5_000 }),
          reply => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: reply.ok && 'runs' in reply ? { type: 'toolResult' as const, result: { text: formatRunList(reply.runs) } } : { type: 'toolError' as const, error: reply.ok ? 'Unexpected workflow runner response.' : reply.error } }),
          error => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: { type: 'toolError' as const, error: String(error) } }),
        )
        return { state }
      }

      if ([getWorkflowRunTool.name, pauseWorkflowRunTool.name, resumeWorkflowRunTool.name].includes(msg.toolName)) {
        const arg = runIdArg(msg.arguments)
        if (!arg.ok) {
          replyError(msg.replyTo, arg.error)
          return { state }
        }
        const type = msg.toolName === getWorkflowRunTool.name ? 'get' : msg.toolName === pauseWorkflowRunTool.name ? 'pause' : 'resume'
        ctx.pipeToSelf(
          ask<WorkflowRunnerMsg, WorkflowRunnerReply>(workflowRunnerRef, replyTo => ({ type, userId: msg.userId, runId: arg.runId, replyTo } as any), { timeoutMs: 10_000 }),
          reply => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: reply.ok && 'run' in reply ? { type: 'toolResult' as const, result: { text: JSON.stringify(reply.run, null, 2) } } : { type: 'toolError' as const, error: reply.ok ? 'Unexpected workflow runner response.' : reply.error } }),
          error => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: { type: 'toolError' as const, error: String(error) } }),
        )
        return { state }
      }

      replyError(msg.replyTo, `Unknown tool: ${msg.toolName}`)
      return { state }
    },
  }),
})
