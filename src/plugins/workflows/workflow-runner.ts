import type { ActorContext, ActorDef, ActorRef, ActorResult } from '../../system/index.ts'
import { ask, onLifecycle, onMessage } from '../../system/index.ts'
import { ToolRegistrationTopic, type ToolCollection } from '../../types/tools.ts'
import { OutboundUserMessageTopic } from '../../types/events.ts'
import { LlmProviderTopic, type LlmProviderMsg } from '../../types/llm.ts'
import { WorkflowEventTopic } from './types.ts'
import type {
  WorkflowRunExecutorMsg,
  WorkflowRunExecutorReply,
  WorkflowRunnerMsg,
  WorkflowRunnerReply,
  ExecutionToolSummary,
  WorkflowRunnerConfig,
} from './types.ts'
import { WorkflowRunExecutor } from './workflow-run-executor.ts'
import { getWorkflowRun, listWorkflowRuns } from './workflow-store.ts'

type RunnerState = {
  live: Record<string, ActorRef<WorkflowRunExecutorMsg>>
  executionTools: ToolCollection
  llmRef: ActorRef<LlmProviderMsg> | null
}

const summarizeExecutionTools = (tools: ToolCollection): ExecutionToolSummary[] =>
  Object.values(tools).map(tool => ({
    name: tool.name,
    description: tool.schema.function.description,
    mayBeLongRunning: tool.mayBeLongRunning,
  }))

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
      WorkflowRunExecutor(workflowRunsDir, state.llmRef, model, maxToolLoops, state.executionTools, userId, runId),
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
    const runId = msg.run.runId
    if (state.live[runId]) {
      msg.replyTo.send({ ok: false, error: `Workflow run ${runId} is already active.`, status: 409 })
      return { state }
    }

    const ref = ctx.spawn(
      `workflow-run-${runId}`,
      WorkflowRunExecutor(workflowRunsDir, state.llmRef, model, maxToolLoops, state.executionTools, msg.run.userId, runId),
    ) as ActorRef<WorkflowRunExecutorMsg>

    const nextState = { ...state, live: { ...state.live, [runId]: ref } }

    ctx.pipeToSelf(
      ask<WorkflowRunExecutorMsg, WorkflowRunExecutorReply>(
        ref,
        replyTo => ({ type: 'start', replyTo }),
        { timeoutMs: 5_000 },
      ),
      reply => ({ type: '_reply' as const, replyTo: msg.replyTo, reply }),
      error => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: { ok: false as const, error: String(error) } }),
    )
    return { state: nextState }
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
    initialState: () => ({ live: {}, executionTools: {}, llmRef: config.llmRef }),
    lifecycle: onLifecycle<WorkflowRunnerMsg, RunnerState>({
      start: (state, ctx) => {
        ctx.subscribe(LlmProviderTopic, event => ({ type: '_llmProvider' as const, ref: event.ref }))
        ctx.subscribe(ToolRegistrationTopic, toolEvent => {
          if ('schema' in toolEvent) return { type: '_toolRegistered' as const, tool: toolEvent }
          return { type: '_toolUnregistered' as const, name: toolEvent.name }
        })
        ctx.subscribe(WorkflowEventTopic, event => ({ type: '_runUpdated' as const, event }))
        return { state }
      },
      terminated: (state, event, ctx) => {
        const parts = event.ref.name.split('/')
        const childName = parts[parts.length - 1] || ''
        const match = childName.match(/^workflow-run-(.+)$/)
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
      _llmProvider: (state, msg) => {
        return { state: { ...state, llmRef: msg.ref } }
      },

      _toolRegistered: (state, msg) => {
        return { state: { ...state, executionTools: { ...state.executionTools, [msg.tool.name]: msg.tool } } }
      },

      _toolUnregistered: (state, msg) => {
        const { [msg.name]: _, ...executionTools } = state.executionTools
        return { state: { ...state, executionTools } }
      },

      _runUpdated: (state, msg, ctx) => {
        const { userId, workflowId, runId, run } = msg.event
        if (run && runId) {
          const text = JSON.stringify({
            type: 'workflowRunUpdated',
            workflowId,
            runId,
            run,
          })
          ctx.publish(OutboundUserMessageTopic, { userId, text })
        } else {
          const text = JSON.stringify({
            type: 'workflowGraph',
            workflowId,
            ...(runId ? { runId } : {}),
          })
          ctx.publish(OutboundUserMessageTopic, { userId, text })
        }
        return { state }
      },

      _done: (state) => ({ state }),

      _reply: (state, msg) => {
        msg.replyTo.send(msg.reply)
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