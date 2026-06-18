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
import { getWorkflow, getWorkflowRun, listWorkflowRuns, saveWorkflowRun } from './workflow-store.ts'
import { validateInputValues } from './validation.ts'

type RunnerState = {
  live: Record<string, ActorRef<WorkflowRunExecutorMsg>>
  executionTools: ToolCollection
  clientsByUser: Record<string, string[]>
  clientUsers: Record<string, string>
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

  const ensureRunActor = (
    state: RunnerState,
    ctx: ActorContext<WorkflowRunnerMsg>,
    userId: string,
    runId: string,
  ): { ref: ActorRef<WorkflowRunExecutorMsg>; spawned: boolean } => {
    const live = state.live[runId]
    if (live) return { ref: live, spawned: false }

    const ref = ctx.spawn(
      `workflow-run-${runId}`,
      WorkflowRunExecutor(workflowRunsDir, llmRef, model, maxToolLoops, state.executionTools, userId, runId),
    ) as ActorRef<WorkflowRunExecutorMsg>
    return { ref, spawned: true }
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
      (async (): Promise<{ reply: WorkflowRunnerReply; runId?: string; spawnedRef?: ActorRef<WorkflowRunExecutorMsg> }> => {
        const workflowResult = await getWorkflow(workflowsDir, msg.userId, msg.workflowId)
        if (!workflowResult.ok) {
          return { reply: { ok: false, error: workflowResult.error, status: workflowResult.status } }
        }
        const workflow = workflowResult.data.workflow
        const inputValidation = validateInputValues(workflow.inputs, msg.inputs)
        if (!inputValidation.ok) return { reply: { ok: false, error: inputValidation.error, status: 400 } }
        const run = initialRunState(workflow, crypto.randomUUID(), inputValidation.values)
        const saveResult = await saveWorkflowRun(workflowRunsDir, run)
        if (!saveResult.ok) {
          return { reply: { ok: false, error: saveResult.error, status: saveResult.status } }
        }
        const ref = ctx.spawn(
          `workflow-run-${run.runId}`,
          WorkflowRunExecutor(workflowRunsDir, llmRef, model, maxToolLoops, state.executionTools, msg.userId, run.runId),
        ) as ActorRef<WorkflowRunExecutorMsg>
        const startReply = await ask<WorkflowRunExecutorMsg, WorkflowRunExecutorReply>(
          ref,
          replyTo => ({ type: 'start', replyTo }),
          { timeoutMs: 5_000 },
        )
        return {
          reply: startReply.ok ? { ok: true, run: startReply.run } : startReply,
          runId: run.runId,
          spawnedRef: ref,
        }
      })(),
      result => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: result.reply, runId: result.runId, spawnedRef: result.spawnedRef }),
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
    const live = state.live[msg.runId]
    if (live) {
      ctx.pipeToSelf(
        ask<WorkflowRunExecutorMsg, WorkflowRunExecutorReply>(
          live,
          replyTo => ({ type: 'resume', replyTo }),
          { timeoutMs: 5_000 },
        ),
        reply => ({ type: '_reply' as const, replyTo: msg.replyTo, reply }),
        error => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: { ok: false as const, error: String(error) } }),
      )
      return { state }
    }

    const { ref, spawned } = ensureRunActor(state, ctx, msg.userId, msg.runId)
    const nextState = spawned ? { ...state, live: { ...state.live, [msg.runId]: ref } } : state

    ctx.pipeToSelf(
      ask<WorkflowRunExecutorMsg, WorkflowRunExecutorReply>(
        ref,
        replyTo => ({ type: 'resume', replyTo }),
        { timeoutMs: 5_000 },
      ),
      reply => ({ type: '_reply' as const, replyTo: msg.replyTo, reply }),
      error => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: { ok: false as const, error: String(error) } }),
    )
    return { state: nextState }
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
      terminated: (state, event, ctx) => {
        const match = event.ref.name.match(/^workflow-run-(.+)$/)
        if (match && match[1]) {
          const runId = match[1]
          if (state.live[runId]) {
            const { [runId]: _, ...live } = state.live
            ctx.log.info('Workflow run executor terminated; removed from runner cache.', { runId })
            return { state: { ...state, live } }
          }
        }
        return { state }
      }
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
        const run = msg.event.run
        const clients = state.clientsByUser[msg.event.userId] ?? []
        const text = JSON.stringify({
          type: 'workflowRunUpdated',
          workflowId: msg.event.workflowId,
          runId: msg.event.runId,
          run,
        })
        for (const clientId of clients) {
          ctx.publish(OutboundMessageTopic, { clientId, text })
        }
        return { state }
      },

      _done: (state) => ({ state }),

      _reply: (state, msg, ctx) => {
        msg.replyTo.send(msg.reply)
        if (msg.runId && msg.spawnedRef) {
          return { state: { ...state, live: { ...state.live, [msg.runId]: msg.spawnedRef } } }
        }
        return { state }
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