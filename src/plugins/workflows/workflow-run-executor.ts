import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActorDef, ActorRef, PersistenceAdapter } from '../../system/index.ts'
import { JobRegistryTopic, type JobLifecycleEvent, type ToolCollection } from '../../types/tools.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import type {
  Workflow,
  WorkflowRunExecutorMsg,
  WorkflowRunState,
  WorkflowTask,
  WorkflowTaskRunState,
} from './types.ts'
import { WorkflowTaskExecutor } from './workflow-task-executor.ts'

type RunExecutorState = {
  run: WorkflowRunState
  workflow: Workflow
  tools: ToolCollection
}

const now = (): string => new Date().toISOString()

const appendEvent = (run: WorkflowRunState, type: string, message: string, taskId?: string): WorkflowRunState => ({
  ...run,
  events: [...run.events, { timestamp: now(), type, message, ...(taskId ? { taskId } : {}) }],
})

const fallbackTaskState = (): WorkflowTaskRunState => ({ status: 'pending', attempts: 0 })

const runPersistence = (
  workflowRunsDir: string,
  runId: string,
  workflow: Workflow,
  tools: ToolCollection,
): PersistenceAdapter<RunExecutorState> => ({
  load: async () => {
    try {
      const parsed = JSON.parse(await Bun.file(join(workflowRunsDir, `${runId}.json`)).text()) as WorkflowRunState
      return { run: parsed, workflow, tools }
    } catch {
      return undefined
    }
  },
  save: async (state) => {
    await mkdir(workflowRunsDir, { recursive: true })
    await Bun.write(join(workflowRunsDir, `${state.run.runId}.json`), JSON.stringify(state.run, null, 2))
  },
})

const initialTaskStates = (workflow: Workflow): Record<string, WorkflowTaskRunState> =>
  Object.fromEntries(workflow.tasks.map(task => [task.id, { status: 'pending', attempts: 0 }]))

export const initialRunState = (
  workflow: Workflow,
  runId: string,
  clientId?: string,
): WorkflowRunState => ({
  schemaVersion: 1,
  runId,
  workflowId: workflow.id,
  userId: workflow.userId,
  clientId,
  status: 'running',
  activeTaskIds: [],
  taskStates: initialTaskStates(workflow),
  activeTasks: {},
  pendingJobs: {},
  events: [{ timestamp: now(), type: 'runStarted', message: `Workflow run ${runId} started.` }],
})

const dependencySummaries = (workflow: Workflow, run: WorkflowRunState, task: WorkflowTask): Record<string, string> =>
  Object.fromEntries(task.dependencies.map(depId => [depId, run.taskStates[depId]?.summary ?? 'Completed.']))

const readyTasks = (workflow: Workflow, run: WorkflowRunState): WorkflowTask[] =>
  workflow.tasks.filter(task =>
    run.taskStates[task.id]?.status === 'pending' &&
    task.dependencies.every(depId => run.taskStates[depId]?.status === 'completed') &&
    !run.activeTasks[task.id],
  )

const terminalRun = (workflow: Workflow, run: WorkflowRunState): WorkflowRunState => {
  const states = workflow.tasks.map(task => run.taskStates[task.id]?.status)
  if (states.every(status => status === 'completed')) return appendEvent({ ...run, status: 'completed' }, 'runCompleted', 'Workflow run completed.')
  if (states.some(status => status === 'failed')) return appendEvent({ ...run, status: 'failed' }, 'runFailed', 'Workflow run failed.')
  if (!run.activeTaskIds.length && !Object.keys(run.pendingJobs).length && states.some(status => status === 'blocked')) {
    return appendEvent({ ...run, status: 'blocked' }, 'runBlocked', 'Workflow run blocked.')
  }
  return run
}

const publishTerminalJob = (ctx: any, run: WorkflowRunState): void => {
  if (run.status === 'completed') {
    ctx.publishRetained(JobRegistryTopic, run.runId, {
      jobId: run.runId,
      status: 'completed',
      result: { text: `Workflow run ${run.runId} completed.` },
    })
  } else if (run.status === 'failed') {
    ctx.publishRetained(JobRegistryTopic, run.runId, {
      jobId: run.runId,
      status: 'failed',
      error: `Workflow run ${run.runId} failed.`,
    })
  } else if (run.status === 'blocked') {
    ctx.publishRetained(JobRegistryTopic, run.runId, {
      jobId: run.runId,
      status: 'completed',
      result: { text: `Workflow run ${run.runId} is blocked.` },
    })
  }
}

export const WorkflowRunExecutor = (
  workflow: Workflow,
  workflowRunsDir: string,
  llmRef: ActorRef<LlmProviderMsg> | null,
  model: string,
  maxToolLoops: number,
  initialRun: WorkflowRunState,
  tools: ToolCollection,
): ActorDef<WorkflowRunExecutorMsg, RunExecutorState> => {
  const schedule = (state: RunExecutorState, ctx: any): RunExecutorState => {
    if (state.run.status !== 'running') return state
    let run = state.run
    for (const task of readyTasks(state.workflow, run)) {
      const actorName = `workflow-task-${run.runId}-${task.id}-${(run.taskStates[task.id]?.attempts ?? 0) + 1}`
      const child = ctx.spawn(actorName, WorkflowTaskExecutor(ctx.self, llmRef, model, maxToolLoops, state.tools))
      child.send({
        type: 'startTask',
        workflow: state.workflow,
        task,
        dependencySummaries: dependencySummaries(state.workflow, run, task),
        userId: run.userId,
        clientId: run.clientId,
      })
      run = appendEvent({
        ...run,
        activeTaskIds: [...run.activeTaskIds, task.id],
        activeTasks: { ...run.activeTasks, [task.id]: { actorName, startedAt: now() } },
        taskStates: {
          ...run.taskStates,
          [task.id]: {
            ...(run.taskStates[task.id] ?? fallbackTaskState()),
            status: 'running',
            attempts: (run.taskStates[task.id]?.attempts ?? 0) + 1,
            startedAt: now(),
            error: undefined,
            blockedReason: undefined,
          },
        },
      }, 'taskStarted', `Task ${task.id} started.`, task.id)
    }
    const next = terminalRun(state.workflow, run)
    if (next.status !== state.run.status) publishTerminalJob(ctx, next)
    return { ...state, run: next }
  }

  const completeTask = (state: RunExecutorState, taskId: string, summary: string, ctx: any): RunExecutorState => {
    const actorName = state.run.activeTasks[taskId]?.actorName
    if (actorName) ctx.stop({ name: actorName })
    const { [taskId]: _active, ...activeTasks } = state.run.activeTasks
    let run = appendEvent({
      ...state.run,
      activeTaskIds: state.run.activeTaskIds.filter(id => id !== taskId),
      activeTasks,
      taskStates: {
        ...state.run.taskStates,
        [taskId]: {
          ...(state.run.taskStates[taskId] ?? fallbackTaskState()),
          status: 'completed',
          completedAt: now(),
          summary,
        },
      },
    }, 'taskCompleted', summary, taskId)
    const next = schedule({ ...state, run }, ctx)
    if (next.run.status !== run.status) publishTerminalJob(ctx, next.run)
    return next
  }

  const resumeRun = (state: RunExecutorState, ctx: any): RunExecutorState => {
    const pendingTaskIds = new Set(Object.values(state.run.pendingJobs).map(job => job.taskId))
    const taskStates = Object.fromEntries(Object.entries(state.run.taskStates).map(([taskId, task]) => [
      taskId,
      pendingTaskIds.has(taskId) || (task.status === 'blocked' && task.blockedReason?.type === 'missing_pending_job')
        ? { ...task, status: 'pending' as const, error: undefined, blockedReason: undefined }
        : task,
    ]))
    const resumed = appendEvent({ ...state.run, status: 'running', pendingJobs: {}, taskStates }, 'runResumed', 'Workflow run resumed.')
    return schedule({ ...state, run: resumed }, ctx)
  }

  return {
    initialState: () => ({ run: initialRun, workflow, tools }),
    persistence: runPersistence(workflowRunsDir, initialRun.runId, workflow, tools),
    lifecycle: (state, event, ctx) => {
      if (event.type === 'start') {
        ctx.subscribe(JobRegistryTopic, jobEvent => ({ type: '_jobRegistry' as const, event: jobEvent }))
      }
      return { state }
    },
    handler: (state, msg, ctx) => {
      switch (msg.type) {
        case 'start': {
          const next = schedule(state, ctx)
          msg.replyTo.send({ ok: true, run: next.run })
          return { state: next }
        }
        case 'get':
          msg.replyTo.send({ ok: true, run: state.run })
          return { state }
        case 'resume': {
          const next = resumeRun(state, ctx)
          msg.replyTo.send({ ok: true, run: next.run })
          return { state: next }
        }
        case 'taskWaiting': {
          const actorName = state.run.activeTasks[msg.taskId]?.actorName
          if (actorName) ctx.stop({ name: actorName })
          const { [msg.taskId]: _active, ...activeTasks } = state.run.activeTasks
          const run = appendEvent({
            ...state.run,
            activeTaskIds: state.run.activeTaskIds.filter(id => id !== msg.taskId),
            activeTasks,
            pendingJobs: {
              ...state.run.pendingJobs,
              [msg.jobId]: {
                taskId: msg.taskId,
                toolName: msg.toolName,
                toolCallId: msg.toolCallId,
                startedAt: now(),
              },
            },
          }, 'taskWaiting', `Task ${msg.taskId} is waiting on ${msg.toolName} (${msg.jobId}).`, msg.taskId)
          return { state: { ...state, run } }
        }
        case 'taskCompleted':
          return { state: completeTask(state, msg.taskId, msg.summary, ctx) }
        case 'taskBlocked': {
          const run = appendEvent({
            ...state.run,
            status: 'blocked',
            activeTaskIds: state.run.activeTaskIds.filter(id => id !== msg.taskId),
            taskStates: {
              ...state.run.taskStates,
              [msg.taskId]: {
                ...(state.run.taskStates[msg.taskId] ?? fallbackTaskState()),
                status: 'blocked',
                error: msg.message,
                blockedReason: { type: 'task_blocked', message: msg.message },
              },
            },
          }, 'taskBlocked', msg.message, msg.taskId)
          publishTerminalJob(ctx, run)
          return { state: { ...state, run } }
        }
        case 'taskFailed': {
          const run = appendEvent({
            ...state.run,
            status: 'failed',
            activeTaskIds: state.run.activeTaskIds.filter(id => id !== msg.taskId),
            taskStates: {
              ...state.run.taskStates,
              [msg.taskId]: { ...(state.run.taskStates[msg.taskId] ?? fallbackTaskState()), status: 'failed', error: msg.error },
            },
          }, 'taskFailed', msg.error, msg.taskId)
          publishTerminalJob(ctx, run)
          return { state: { ...state, run } }
        }
        case '_jobRegistry': {
          const jobEvent = msg.event as JobLifecycleEvent
          if ((jobEvent.status === 'completed' || jobEvent.status === 'failed') && state.run.pendingJobs[jobEvent.jobId]) {
            const pending = state.run.pendingJobs[jobEvent.jobId]
            if (!pending) return { state }
            const { [jobEvent.jobId]: _, ...pendingJobs } = state.run.pendingJobs
            const summary = jobEvent.status === 'completed'
              ? jobEvent.result.text
              : `Tool ${pending.toolName} failed: ${jobEvent.error}`
            const withJobCleared = { ...state, run: { ...state.run, pendingJobs } }
            if (jobEvent.status === 'completed') {
              return { state: completeTask(withJobCleared, pending.taskId, summary, ctx) }
            }
            const failedRun = appendEvent({ ...withJobCleared.run, status: 'failed' }, 'taskFailed', summary, pending.taskId)
            publishTerminalJob(ctx, failedRun)
            return { state: { ...withJobCleared, run: failedRun } }
          }
          return { state }
        }
        case '_done':
          return { state }
      }
    },
  }
}
