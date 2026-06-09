import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActorDef, ActorRef } from '../../system/index.ts'
import { ask } from '../../system/index.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import type {
  WorkflowRunExecutorMsg,
  WorkflowRunExecutorReply,
  WorkflowRunnerMsg,
  WorkflowRunnerReply,
  WorkflowRunState,
  WorkflowStoreMsg,
  WorkflowStoreReply,
} from './types.ts'
import { initialRunState, WorkflowRunExecutor } from './workflow-run-executor.ts'

type RunnerState = {
  live: Record<string, ActorRef<WorkflowRunExecutorMsg>>
}

const readRun = async (filepath: string): Promise<WorkflowRunState | null> => {
  try {
    const parsed = JSON.parse(await Bun.file(filepath).text()) as WorkflowRunState
    return parsed && typeof parsed.runId === 'string' && typeof parsed.userId === 'string' ? parsed : null
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

    const ref = ctx.spawn(
      `workflow-run-${run.runId}`,
      WorkflowRunExecutor(workflowReply.workflow, workflowRunsDir, llmRef, model, maxToolLoops, run),
    ) as ActorRef<WorkflowRunExecutorMsg>
    return { ref, state: { ...state, live: { ...state.live, [run.runId]: ref } } }
  }

  return {
    initialState: { live: {} },
    handler: (state, msg, ctx) => {
      if (msg.type === '_done') return { state }
      if (msg.type === '_reply') {
        msg.replyTo.send(msg.reply)
        return { state: msg.live ? { ...state, live: msg.live } : state }
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
            const run = initialRunState(workflowReply.workflow, crypto.randomUUID(), msg.clientId)
            const ref = ctx.spawn(
              `workflow-run-${run.runId}`,
              WorkflowRunExecutor(workflowReply.workflow, workflowRunsDir, llmRef, model, maxToolLoops, run),
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

      if (msg.type === 'get' || msg.type === 'pause' || msg.type === 'resume') {
        ctx.pipeToSelf(
          (async (): Promise<{ reply: WorkflowRunnerReply; live?: Record<string, ActorRef<WorkflowRunExecutorMsg>> }> => {
            const live = state.live[msg.runId]
            if (live) {
              const reply = await ask<WorkflowRunExecutorMsg, WorkflowRunExecutorReply>(
                live,
                replyTo => ({ type: msg.type, replyTo } as any),
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
              replyTo => ({ type: msg.type, replyTo } as any),
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
