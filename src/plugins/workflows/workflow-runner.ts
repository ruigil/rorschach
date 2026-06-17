import type { ActorContext, ActorDef, ActorRef, ActorResult } from '../../system/index.ts'
import { ask, onLifecycle, onMessage } from '../../system/index.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import { ToolRegistrationTopic, type ToolCollection } from '../../types/tools.ts'
import { ClientPresenceTopic, OutboundMessageTopic } from '../../types/events.ts'
import { WorkflowRunUpdateTopic } from './types.ts'
import type {
  WorkflowRunExecutorMsg,
  WorkflowRunExecutorReply,
  WorkflowRunnerMsg,
  WorkflowRunnerReply,
  WorkflowRunState,
  Workflow,
  ExecutionToolSummary,
  WorkflowRunnerConfig,
} from './types.ts'
import { initialRunState, WorkflowRunExecutor } from './workflow-run-executor.ts'
import { getWorkflow, getWorkflowRun, listWorkflowRuns } from './workflow-store.ts'
import { validateInputValues } from './validation.ts'

type RunnerState = {
  live: Record<string, ActorRef<WorkflowRunExecutorMsg>>
  executionTools: ToolCollection
  clientsByUser: Record<string, string[]>
  clientUsers: Record<string, string>
}

const filterWorkflowTools = (workflow: Workflow, tools: ToolCollection): ToolCollection => {
  const filtered: ToolCollection = {}
  for (const name of workflow.executionTools) {
    const tool = tools[name]
    if (tool) filtered[name] = tool
  }
  return filtered
}

const summarizeExecutionTools = (tools: ToolCollection): ExecutionToolSummary[] =>
  Object.values(tools).map(tool => ({
    name: tool.name,
    description: tool.schema.function.description,
    mayBeLongRunning: tool.mayBeLongRunning,
  }))

const addClientForUser = (state: RunnerState, userId: string, clientId: string): RunnerState => {
  const base = state.clientUsers[clientId] && state.clientUsers[clientId] !== userId
    ? removeClient(state, clientId)
    : state
  const current = base.clientsByUser[userId] ?? []
  const clients = current.includes(clientId) ? current : [...current, clientId]
  return {
    ...base,
    clientsByUser: { ...base.clientsByUser, [userId]: clients },
    clientUsers: { ...base.clientUsers, [clientId]: userId },
  }
}

const removeClient = (state: RunnerState, clientId: string): RunnerState => {
  const userId = state.clientUsers[clientId]
  if (!userId) return state
  const { [clientId]: _, ...clientUsers } = state.clientUsers
  const clients = (state.clientsByUser[userId] ?? []).filter(id => id !== clientId)
  const { [userId]: __, ...clientsByUser } = state.clientsByUser
  return {
    ...state,
    clientUsers,
    clientsByUser: clients.length ? { ...clientsByUser, [userId]: clients } : clientsByUser,
  }
}

export const WorkflowRunner = (
  config: WorkflowRunnerConfig,
): ActorDef<WorkflowRunnerMsg, RunnerState> => {
  const { workflowsDir, workflowRunsDir, llmRef, model, maxToolLoops } = config

  const ensureRunActor = async (
    state: RunnerState,
    ctx: ActorContext<WorkflowRunnerMsg>,
    run: WorkflowRunState,
  ): Promise<{ ref: ActorRef<WorkflowRunExecutorMsg>; state: RunnerState } | WorkflowRunnerReply> => {

    const live = state.live[run.runId]
    if (live) return { ref: live, state }

    const workflowResult = await getWorkflow(workflowsDir, run.userId, run.workflowId)
    if (!workflowResult.ok) return { ok: false, error: workflowResult.error, status: workflowResult.status }
    const workflow = workflowResult.data.workflow

    const ref = ctx.spawn(
      `workflow-run-${run.runId}`,
      WorkflowRunExecutor(workflow, workflowRunsDir, llmRef, model, maxToolLoops, run, filterWorkflowTools(workflow, state.executionTools)),
    ) as ActorRef<WorkflowRunExecutorMsg>
    return { ref, state: { ...state, live: { ...state.live, [run.runId]: ref } } }
  }

  const listRuns = (
    state: RunnerState,
    msg: Extract<WorkflowRunnerMsg, { type: 'list' }>,
    ctx: ActorContext<WorkflowRunnerMsg>,
  ): ActorResult<WorkflowRunnerMsg, RunnerState> => {
    ctx.pipeToSelf(
      listWorkflowRuns(workflowRunsDir, msg.userId),
      runs => {
        msg.replyTo.send({ ok: true, runs })
        return { type: '_done' }
      },
      error => {
        msg.replyTo.send({ ok: false, error: String(error) })
        return { type: '_done' }
      },
    )
    return { state }
  }

  const startRun = (
    state: RunnerState,
    msg: Extract<WorkflowRunnerMsg, { type: 'start' }>,
    ctx: ActorContext<WorkflowRunnerMsg>,
  ): ActorResult<WorkflowRunnerMsg, RunnerState> => {
    ctx.pipeToSelf(
      (async (): Promise<{ reply: WorkflowRunnerReply; live?: Record<string, ActorRef<WorkflowRunExecutorMsg>> }> => {
        const workflowResult = await getWorkflow(workflowsDir, msg.userId, msg.workflowId)
        if (!workflowResult.ok) {
          return { reply: { ok: false, error: workflowResult.error, status: workflowResult.status } }
        }
        const workflow = workflowResult.data.workflow
        const inputValidation = validateInputValues(workflow.inputs, msg.inputs)
        if (!inputValidation.ok) return { reply: { ok: false, error: inputValidation.error, status: 400 } }
        const run = initialRunState(workflow, crypto.randomUUID(), inputValidation.values)
        const ref = ctx.spawn(
          `workflow-run-${run.runId}`,
          WorkflowRunExecutor(workflow, workflowRunsDir, llmRef, model, maxToolLoops, run, filterWorkflowTools(workflow, state.executionTools)),
        ) as ActorRef<WorkflowRunExecutorMsg>
        const startReply = await ask<WorkflowRunExecutorMsg, WorkflowRunExecutorReply>(
          ref,
          replyTo => ({ type: 'start', replyTo }),
          { timeoutMs: 5_000 },
        )
        return {
          reply: startReply.ok ? { ok: true, run: startReply.run } : startReply,
          live: { ...state.live, [run.runId]: ref },
        }
      })(),
      result => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: result.reply, live: result.live }),
      error => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: { ok: false as const, error: String(error) } }),
    )
    return { state }
  }

  const getRun = (
    state: RunnerState,
    msg: Extract<WorkflowRunnerMsg, { type: 'get' }>,
    ctx: ActorContext<WorkflowRunnerMsg>,
  ): ActorResult<WorkflowRunnerMsg, RunnerState> => {
    ctx.pipeToSelf(
      (async (): Promise<WorkflowRunnerReply> => {
        const live = state.live[msg.runId]
        if (live) {
          return await ask<WorkflowRunExecutorMsg, WorkflowRunExecutorReply>(
            live,
            replyTo => ({ type: 'get', replyTo }),
            { timeoutMs: 5_000 },
          )
        }
        const diskReply = await getWorkflowRun(workflowRunsDir, msg.userId, msg.runId)
        if (!diskReply.ok) return diskReply
        return { ok: true, run: diskReply.data }
      })(),
      reply => ({ type: '_reply' as const, replyTo: msg.replyTo, reply }),
      error => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: { ok: false as const, error: String(error) } }),
    )
    return { state }
  }

  const resumeRun = (
    state: RunnerState,
    msg: Extract<WorkflowRunnerMsg, { type: 'resume' }>,
    ctx: ActorContext<WorkflowRunnerMsg>,
  ): ActorResult<WorkflowRunnerMsg, RunnerState> => {
    ctx.pipeToSelf(
      (async (): Promise<{ reply: WorkflowRunnerReply; live?: Record<string, ActorRef<WorkflowRunExecutorMsg>> }> => {
        const live = state.live[msg.runId]
        if (live) {
          const reply = await ask<WorkflowRunExecutorMsg, WorkflowRunExecutorReply>(
            live,
            replyTo => ({ type: 'resume', replyTo }),
            { timeoutMs: 5_000 },
          )
          return { reply }
        }
        const diskReply = await getWorkflowRun(workflowRunsDir, msg.userId, msg.runId)
        if (!diskReply.ok) return { reply: diskReply }
        const ensured = await ensureRunActor(state, ctx, diskReply.data)
        if ('ok' in ensured) return { reply: ensured }
        const reply = await ask<WorkflowRunExecutorMsg, WorkflowRunExecutorReply>(
          ensured.ref,
          replyTo => ({ type: 'resume', replyTo }),
          { timeoutMs: 5_000 },
        )
        return { reply, live: ensured.state.live }
      })(),
      result => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: result.reply, live: result.live }),
      error => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: { ok: false as const, error: String(error) } }),
    )
    return { state }
  }

  return {
    initialState: { live: {}, executionTools: {}, clientsByUser: {}, clientUsers: {} },
    lifecycle: onLifecycle<WorkflowRunnerMsg, RunnerState>({
      start: (state, ctx) => {
        ctx.subscribe(ToolRegistrationTopic, toolEvent => {
          if ('schema' in toolEvent) return { type: '_toolRegistered' as const, tool: toolEvent }
          return { type: '_toolUnregistered' as const, name: toolEvent.name }
        })
        ctx.subscribe(ClientPresenceTopic, clientEvent => {
          if (clientEvent.status === 'connected') return { type: '_clientConnected' as const, userId: clientEvent.userId, clientId: clientEvent.clientId }
          return { type: '_clientDisconnected' as const, clientId: clientEvent.clientId }
        })
        ctx.subscribe(WorkflowRunUpdateTopic, event => ({ type: '_runUpdated' as const, event }))
        return { state }
      },
    }),
    handler: onMessage<WorkflowRunnerMsg, RunnerState>({
      _toolRegistered: (state, msg) => {
        return { state: { ...state, executionTools: { ...state.executionTools, [msg.tool.name]: msg.tool } } }
      },

      _toolUnregistered: (state, msg) => {
        const { [msg.name]: _, ...executionTools } = state.executionTools
        return { state: { ...state, executionTools } }
      },

      _clientConnected: (state, msg) => {
        return { state: addClientForUser(state, msg.userId, msg.clientId) }
      },

      _clientDisconnected: (state, msg) => {
        return { state: removeClient(state, msg.clientId) }
      },

      _runUpdated: (state, msg, ctx) => {
        const clients = state.clientsByUser[msg.event.userId] ?? []
        const text = JSON.stringify({
          type: 'workflowRunUpdated',
          workflowId: msg.event.workflowId,
          runId: msg.event.runId,
          run: msg.event.run,
        })
        for (const clientId of clients) {
          ctx.publish(OutboundMessageTopic, { clientId, text })
        }
        return { state }
      },

      _done: (state) => ({ state }),

      _reply: (state, msg) => {
        msg.replyTo.send(msg.reply)
        return { state: msg.live ? { ...state, live: msg.live } : state }
      },

      listExecutionTools: (state, msg) => {
        msg.replyTo.send({ ok: true, executionTools: summarizeExecutionTools(state.executionTools) })
        return { state }
      },

      list: listRuns,
      start: startRun,
      get: getRun,
      resume: resumeRun,
    }),
  }
}