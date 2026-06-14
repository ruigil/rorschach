import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActorDef, ActorRef } from '../../system/index.ts'
import { ask } from '../../system/index.ts'
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
  WorkflowStoreMsg,
  WorkflowStoreReply,
} from './types.ts'
import { initialRunState, WorkflowRunExecutor } from './workflow-run-executor.ts'
import { isWorkflowControlTool } from './tools.ts'
import { validateInputValues } from './validation.ts'

const SWITCH_MODE_TOOL_NAME = 'switch_mode'

type RunnerState = {
  live: Record<string, ActorRef<WorkflowRunExecutorMsg>>
  executionTools: ToolCollection
  clientsByUser: Record<string, string[]>
  clientUsers: Record<string, string>
}

const readRun = async (filepath: string): Promise<WorkflowRunState | null> => {
  try {
    const parsed = JSON.parse(await Bun.file(filepath).text()) as WorkflowRunState
    return parsed && typeof parsed.runId === 'string' && typeof parsed.userId === 'string'
      ? { ...parsed, inputs: parsed.inputs ?? {}, outputs: parsed.outputs ?? {} }
      : null
  } catch {
    return null
  }
}

const scanRuns = async (workflowRunsDir: string, userId: string): Promise<WorkflowRunState[]> => {
  try {
    const entries = await readdir(workflowRunsDir, { withFileTypes: true })
    const loaded = await Promise.all(entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => readRun(join(workflowRunsDir, entry.name))))
    return loaded
      .filter((run): run is WorkflowRunState => run !== null && run.userId === userId)
      .sort((a, b) => (b.events[0]?.timestamp ?? '').localeCompare(a.events[0]?.timestamp ?? ''))
  } catch {
    return []
  }
}

const getRunFromDisk = async (workflowRunsDir: string, userId: string, runId: string): Promise<WorkflowRunnerReply> => {
  const run = await readRun(join(workflowRunsDir, `${runId}.json`))
  if (!run || run.userId !== userId) return { ok: false, error: `Workflow run not found: ${runId}`, status: 404 }
  return { ok: true, run }
}

const writeRun = async (workflowRunsDir: string, run: WorkflowRunState): Promise<void> => {
  await mkdir(workflowRunsDir, { recursive: true })
  await Bun.write(join(workflowRunsDir, `${run.runId}.json`), JSON.stringify(run, null, 2))
}

const filterWorkflowTools = (workflow: Workflow, tools: ToolCollection): ToolCollection => {
  const filtered: ToolCollection = {}
  for (const name of workflow.executionTools) {
    const tool = tools[name]
    if (tool) filtered[name] = tool
  }
  return filtered
}

const missingExecutionTool = (workflow: Workflow, tools: ToolCollection): string | undefined =>
  workflow.executionTools.find(name => !tools[name])

const summarizeExecutionTools = (tools: ToolCollection): ExecutionToolSummary[] =>
  Object.values(tools).map(tool => ({
    name: tool.name,
    description: tool.schema.function.description,
    mayBeLongRunning: tool.mayBeLongRunning,
  }))

const blockedMissingToolRun = (run: WorkflowRunState, missingTool: string): WorkflowRunState => {
  const message = `Required execution tool is unavailable: ${missingTool}`
  return {
    ...run,
    status: 'blocked',
    taskStates: Object.fromEntries(Object.entries(run.taskStates).map(([taskId, task]) => [
      taskId,
      {
        ...task,
        status: 'blocked' as const,
        error: message,
        blockedReason: { type: 'task_blocked' as const, message },
      },
    ])),
    events: [...run.events, { timestamp: new Date().toISOString(), type: 'runBlocked', message }],
  }
}

const publishRunUpdate = (ctx: any, run: WorkflowRunState): void => {
  ctx.publish(WorkflowRunUpdateTopic, {
    userId: run.userId,
    workflowId: run.workflowId,
    runId: run.runId,
    run,
  })
}

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
  workflowStoreRef: ActorRef<WorkflowStoreMsg>,
  workflowRunsDir: string,
  llmRef: ActorRef<LlmProviderMsg> | null,
  model: string,
  maxToolLoops: number,
): ActorDef<WorkflowRunnerMsg, RunnerState> => {
  const ensureRunActor = async (
    state: RunnerState,
    ctx: any,
    run: WorkflowRunState,
  ): Promise<{ ref: ActorRef<WorkflowRunExecutorMsg>; state: RunnerState } | WorkflowRunnerReply> => {
    const live = state.live[run.runId]
    if (live) return { ref: live, state }

    const workflowReply = await ask<WorkflowStoreMsg, WorkflowStoreReply>(
      workflowStoreRef,
      replyTo => ({ type: 'get', userId: run.userId, workflowId: run.workflowId, replyTo }),
      { timeoutMs: 5_000 },
    )
    if (!workflowReply.ok || !('workflow' in workflowReply)) {
      return { ok: false, error: workflowReply.ok ? 'Unexpected workflow store response.' : workflowReply.error, status: workflowReply.ok ? 500 : workflowReply.status }
    }
    const missingTool = missingExecutionTool(workflowReply.workflow, state.executionTools)
    if (missingTool) {
      const blocked = blockedMissingToolRun(run, missingTool)
      await writeRun(workflowRunsDir, blocked)
      publishRunUpdate(ctx, blocked)
      return { ok: true, run: blocked }
    }

    const ref = ctx.spawn(
      `workflow-run-${run.runId}`,
      WorkflowRunExecutor(workflowReply.workflow, workflowRunsDir, llmRef, model, maxToolLoops, run, filterWorkflowTools(workflowReply.workflow, state.executionTools)),
    ) as ActorRef<WorkflowRunExecutorMsg>
    return { ref, state: { ...state, live: { ...state.live, [run.runId]: ref } } }
  }

  return {
    initialState: { live: {}, executionTools: {}, clientsByUser: {}, clientUsers: {} },
    lifecycle: (state, event, ctx) => {
      if (event.type === 'start') {
        ctx.subscribe(ToolRegistrationTopic, toolEvent => {
          if (isWorkflowControlTool(toolEvent.name) || toolEvent.name === SWITCH_MODE_TOOL_NAME) return null
          if ('schema' in toolEvent) return { type: '_toolRegistered' as const, tool: toolEvent }
          return { type: '_toolUnregistered' as const, name: toolEvent.name }
        })
        ctx.subscribe(ClientPresenceTopic, clientEvent => {
          if (clientEvent.status === 'connected') return { type: '_clientConnected' as const, userId: clientEvent.userId, clientId: clientEvent.clientId }
          return { type: '_clientDisconnected' as const, clientId: clientEvent.clientId }
        })
        ctx.subscribe(WorkflowRunUpdateTopic, event => ({ type: '_runUpdated' as const, event }))
      }
      return { state }
    },
    handler: (state, msg, ctx) => {
      if (msg.type === '_toolRegistered') {
        return { state: { ...state, executionTools: { ...state.executionTools, [msg.tool.name]: msg.tool } } }
      }
      if (msg.type === '_toolUnregistered') {
        const { [msg.name]: _, ...executionTools } = state.executionTools
        return { state: { ...state, executionTools } }
      }
      if (msg.type === '_clientConnected') {
        return { state: addClientForUser(state, msg.userId, msg.clientId) }
      }
      if (msg.type === '_clientDisconnected') {
        return { state: removeClient(state, msg.clientId) }
      }
      if (msg.type === '_runUpdated') {
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
      }
      if (msg.type === '_done') return { state }
      if (msg.type === '_reply') {
        msg.replyTo.send(msg.reply)
        return { state: msg.live ? { ...state, live: msg.live } : state }
      }

      if (msg.type === 'listExecutionTools') {
        msg.replyTo.send({ ok: true, executionTools: summarizeExecutionTools(state.executionTools) })
        return { state }
      }

      if (msg.type === 'list') {
        ctx.pipeToSelf(
          scanRuns(workflowRunsDir, msg.userId),
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

      if (msg.type === 'start') {
        ctx.pipeToSelf(
          (async (): Promise<{ reply: WorkflowRunnerReply; live?: Record<string, ActorRef<WorkflowRunExecutorMsg>> }> => {
            const workflowReply = await ask<WorkflowStoreMsg, WorkflowStoreReply>(
              workflowStoreRef,
              replyTo => ({ type: 'get', userId: msg.userId, workflowId: msg.workflowId, replyTo }),
              { timeoutMs: 5_000 },
            )
            if (!workflowReply.ok || !('workflow' in workflowReply)) {
              return { reply: { ok: false, error: workflowReply.ok ? 'Unexpected workflow store response.' : workflowReply.error, status: workflowReply.ok ? 500 : workflowReply.status } }
            }
            const inputValidation = validateInputValues(workflowReply.workflow.inputs, msg.inputs)
            if (!inputValidation.ok) return { reply: { ok: false, error: inputValidation.error, status: 400 } }
            const run = initialRunState(workflowReply.workflow, crypto.randomUUID(), inputValidation.values)
            const missingTool = missingExecutionTool(workflowReply.workflow, state.executionTools)
            if (missingTool) {
              const blocked = blockedMissingToolRun(run, missingTool)
              await writeRun(workflowRunsDir, blocked)
              publishRunUpdate(ctx, blocked)
              return { reply: { ok: true, run: blocked } }
            }
            const ref = ctx.spawn(
              `workflow-run-${run.runId}`,
              WorkflowRunExecutor(workflowReply.workflow, workflowRunsDir, llmRef, model, maxToolLoops, run, filterWorkflowTools(workflowReply.workflow, state.executionTools)),
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
          error => {
            return { type: '_reply' as const, replyTo: msg.replyTo, reply: { ok: false as const, error: String(error) } }
          },
        )
        return { state }
      }

      if (msg.type === 'get' || msg.type === 'resume') {
        ctx.pipeToSelf(
          (async (): Promise<{ reply: WorkflowRunnerReply; live?: Record<string, ActorRef<WorkflowRunExecutorMsg>> }> => {
            const live = state.live[msg.runId]
            if (live) {
              const reply = await ask<WorkflowRunExecutorMsg, WorkflowRunExecutorReply>(
                live,
                replyTo => msg.type === 'get' ? { type: 'get', replyTo } : { type: 'resume', replyTo },
                { timeoutMs: 5_000 },
              )
              return { reply }
            }
            const diskReply = await getRunFromDisk(workflowRunsDir, msg.userId, msg.runId)
            if (!diskReply.ok || !('run' in diskReply)) return { reply: diskReply }
            if (msg.type === 'get') return { reply: diskReply }
            const ensured = await ensureRunActor(state, ctx, diskReply.run)
            if ('ok' in ensured) return { reply: ensured }
            const reply = await ask<WorkflowRunExecutorMsg, WorkflowRunExecutorReply>(
              ensured.ref,
              replyTo => ({ type: 'resume', replyTo }),
              { timeoutMs: 5_000 },
            )
            return { reply, live: ensured.state.live }
          })(),
          result => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: result.reply, live: result.live }),
          error => {
            return { type: '_reply' as const, replyTo: msg.replyTo, reply: { ok: false as const, error: String(error) } }
          },
        )
        return { state }
      }

      return { state }
    },
  }
}
