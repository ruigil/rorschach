import { mkdir } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { ActorContext, ActorDef, ActorRef, PersistenceAdapter } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { JobRegistryTopic, type ToolCollection } from '../../types/tools.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import { WorkflowRunUpdateTopic } from './types.ts'
import type {
  Workflow,
  WorkflowDependencyOutput,
  WorkflowRunExecutorReply,
  WorkflowRunExecutorMsg,
  WorkflowRunState,
  WorkflowTask,
  WorkflowTaskRunState,
} from './types.ts'
import { WorkflowTaskExecutor } from './workflow-task-executor.ts'
import { validateOutputValues } from './validation.ts'

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

const withRunDefaults = (run: WorkflowRunState): WorkflowRunState => ({
  ...run,
  inputs: run.inputs ?? {},
  outputs: run.outputs ?? {},
})

const hostArtifactRoot = (workflowRunsDir: string, runId: string): string => join(workflowRunsDir, runId)

const toolArtifactRoot = (workflowRunsDir: string, runId: string): string => {
  const workspaceRoot = resolve('workspace')
  const runsRoot = resolve(workflowRunsDir)
  const rel = relative(workspaceRoot, runsRoot)
  if (rel && !rel.startsWith('..') && rel !== '..') return `/workspace/${rel.split(sep).join('/')}/${runId}`
  return `/workspace/workflows/runs/${runId}`
}

const ensureArtifactRoot = (workflowRunsDir: string, runId: string): void => {
  mkdirSync(hostArtifactRoot(workflowRunsDir, runId), { recursive: true })
}

const runPersistence = (
  workflowRunsDir: string,
  runId: string,
  workflow: Workflow,
  tools: ToolCollection,
): PersistenceAdapter<RunExecutorState> => ({
  load: async () => {
    try {
      const parsed = JSON.parse(await Bun.file(join(workflowRunsDir, `${runId}.json`)).text()) as WorkflowRunState
      return { run: withRunDefaults(parsed), workflow, tools }
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
  inputs: Record<string, unknown> = {},
): WorkflowRunState => ({
  schemaVersion: 1,
  runId,
  workflowId: workflow.id,
  userId: workflow.userId,
  status: 'running',
  inputs,
  outputs: {},
  activeTaskIds: [],
  taskStates: initialTaskStates(workflow),
  activeTasks: {},
  pendingJobs: {},
  events: [{ timestamp: now(), type: 'runStarted', message: `Workflow run ${runId} started.` }],
})

const dependencyOutputs = (run: WorkflowRunState, task: WorkflowTask): Record<string, WorkflowDependencyOutput> =>
  Object.fromEntries(task.dependencies.map(depId => [
    depId,
    {
      ...(run.taskStates[depId]?.summary ? { summary: run.taskStates[depId]?.summary } : {}),
      ...(run.taskStates[depId]?.outputs ? { outputs: run.taskStates[depId]?.outputs } : {}),
    },
  ]))

const formatResumeContext = (toolName: string, text: string): string =>
  `A previously pending tool completed.\n\nTool: ${toolName}\nResult:\n${text}\n\nContinue from this result. When done, call complete_workflow_task. If blocked, call block_workflow_task.`

const readyTasks = (workflow: Workflow, run: WorkflowRunState): WorkflowTask[] =>
  workflow.tasks.filter(task =>
    run.taskStates[task.id]?.status === 'pending' &&
    task.dependencies.every(depId => run.taskStates[depId]?.status === 'completed') &&
    !run.activeTasks[task.id],
  )

const terminalRun = (workflow: Workflow, run: WorkflowRunState): WorkflowRunState => {
  const states = workflow.tasks.map(task => run.taskStates[task.id]?.status)
  if (states.every(status => status === 'completed')) {
    const outputs = resolveWorkflowOutputs(workflow, run)
    if (!outputs.ok) return appendEvent({ ...run, status: 'failed' }, 'runFailed', outputs.error)
    return appendEvent({ ...run, outputs: outputs.outputs, status: 'completed' }, 'runCompleted', 'Workflow run completed.')
  }
  if (states.some(status => status === 'failed')) return appendEvent({ ...run, status: 'failed' }, 'runFailed', 'Workflow run failed.')
  if (!run.activeTaskIds.length && !Object.keys(run.pendingJobs).length && states.some(status => status === 'blocked')) {
    return appendEvent({ ...run, status: 'blocked' }, 'runBlocked', 'Workflow run blocked.')
  }
  return run
}

const resolveWorkflowOutputs = (workflow: Workflow, run: WorkflowRunState): { ok: true; outputs: WorkflowRunState['outputs'] } | { ok: false; error: string } => {
  const values: Record<string, unknown> = {}
  for (const key of Object.keys(workflow.outputs ?? {})) {
    for (const task of workflow.tasks) {
      const taskOutputs = run.taskStates[task.id]?.outputs
      if (taskOutputs && taskOutputs[key] !== undefined) values[key] = taskOutputs[key]
    }
  }
  const validated = validateOutputValues('workflow', workflow.outputs, values)
  return validated.ok ? { ok: true, outputs: validated.values } : { ok: false, error: validated.error }
}

const publishTerminalJob = (ctx: ActorContext<WorkflowRunExecutorMsg>, run: WorkflowRunState): void => {
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

const publishRunUpdate = (ctx: ActorContext<WorkflowRunExecutorMsg>, run: WorkflowRunState): void => {
  ctx.publish(WorkflowRunUpdateTopic, {
    userId: run.userId,
    workflowId: run.workflowId,
    runId: run.runId,
    run,
  })
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
  const schedule = (state: RunExecutorState, ctx: ActorContext<WorkflowRunExecutorMsg>, resumeContexts: Record<string, string> = {}): RunExecutorState => {
    if (state.run.status !== 'running') return state
    let run = state.run
    for (const task of readyTasks(state.workflow, run)) {
      ensureArtifactRoot(workflowRunsDir, run.runId)
      const actorName = `workflow-task-${run.runId}-${task.id}-${(run.taskStates[task.id]?.attempts ?? 0) + 1}`
      const child = ctx.spawn(actorName, WorkflowTaskExecutor(ctx.self, llmRef, model, maxToolLoops, state.tools))
      child.send({
        type: 'startTask',
        workflow: state.workflow,
        task,
        inputs: run.inputs,
        artifactRoot: toolArtifactRoot(workflowRunsDir, run.runId),
        dependencyOutputs: dependencyOutputs(run, task),
        ...(resumeContexts[task.id] ? { resumeContext: resumeContexts[task.id] } : {}),
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

  const completeTask = (state: RunExecutorState, taskId: string, summary: string, outputs: WorkflowRunState['outputs'], ctx: ActorContext<WorkflowRunExecutorMsg>): RunExecutorState => {
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
          outputs,
        },
      },
    }, 'taskCompleted', summary, taskId)
    const next = schedule({ ...state, run }, ctx)
    if (next.run.status !== run.status) publishTerminalJob(ctx, next.run)
    return next
  }

  const resumeRun = (state: RunExecutorState, ctx: ActorContext<WorkflowRunExecutorMsg>): { ok: true; state: RunExecutorState } | Extract<WorkflowRunExecutorReply, { ok: false }> => {
    if (state.run.status === 'completed' || state.run.status === 'failed') {
      return { ok: false, error: `Workflow run is not resumable: ${state.run.status}`, status: 409 }
    }
    const pendingTaskIds = new Set(Object.values(state.run.pendingJobs).map(job => job.taskId))
    const activeTaskIds = new Set(state.run.activeTaskIds)
    const shouldRetryTask = (taskId: string, task: WorkflowTaskRunState): boolean =>
      pendingTaskIds.has(taskId) ||
      (activeTaskIds.has(taskId) && task.status === 'running') ||
      (task.status === 'blocked' && (
        task.blockedReason?.type === 'missing_pending_job' ||
        task.blockedReason?.type === 'task_blocked'
      ))
    const retryTaskIds = Object.entries(state.run.taskStates)
      .filter(([taskId, task]) => shouldRetryTask(taskId, task))
      .map(([taskId]) => taskId)
    if (!retryTaskIds.length) {
      return { ok: false, error: 'Workflow run is not resumable: no pending, active, or blocked tasks to retry.', status: 409 }
    }
    for (const taskId of retryTaskIds) {
      const actorName = state.run.activeTasks[taskId]?.actorName
      if (actorName) ctx.stop({ name: actorName })
    }
    const retryTaskIdSet = new Set(retryTaskIds)
    const activeTasks = Object.fromEntries(Object.entries(state.run.activeTasks).filter(([taskId]) => !retryTaskIdSet.has(taskId)))
    const taskStates = Object.fromEntries(Object.entries(state.run.taskStates).map(([taskId, task]) => [
      taskId,
      retryTaskIdSet.has(taskId)
        ? { ...task, status: 'pending' as const, error: undefined, blockedReason: undefined }
        : task,
    ]))
    const resumed = appendEvent({
      ...state.run,
      status: 'running',
      activeTaskIds: state.run.activeTaskIds.filter(taskId => !retryTaskIdSet.has(taskId)),
      activeTasks,
      pendingJobs: {},
      taskStates,
    }, 'runResumed', 'Workflow run resumed.')
    return { ok: true, state: schedule({ ...state, run: resumed }, ctx) }
  }

  return {
    initialState: () => ({ run: initialRun, workflow, tools }),
    persistence: runPersistence(workflowRunsDir, initialRun.runId, workflow, tools),
    lifecycle: onLifecycle<WorkflowRunExecutorMsg, RunExecutorState>({
      start: (state, ctx) => {
        ctx.subscribe(JobRegistryTopic, jobEvent => ({ type: '_jobRegistry' as const, event: jobEvent }))
        return { state }
      },
    }),
    handler: onMessage<WorkflowRunExecutorMsg, RunExecutorState>({
      start: (state, msg, ctx) => {
        ensureArtifactRoot(workflowRunsDir, state.run.runId)
        const next = schedule(state, ctx)
        publishRunUpdate(ctx, next.run)
        msg.replyTo.send({ ok: true, run: next.run })
        return { state: next }
      },

      get: (state, msg) => {
        msg.replyTo.send({ ok: true, run: state.run })
        return { state }
      },

      resume: (state, msg, ctx) => {
        const next = resumeRun(state, ctx)
        if (!next.ok) {
          msg.replyTo.send(next)
          return { state }
        }
        publishRunUpdate(ctx, next.state.run)
        msg.replyTo.send({ ok: true, run: next.state.run })
        return { state: next.state }
      },

      taskWaiting: (state, msg, ctx) => {
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
        publishRunUpdate(ctx, run)
        return { state: { ...state, run } }
      },

      taskCompleted: (state, msg, ctx) => {
        const next = completeTask(state, msg.taskId, msg.summary, msg.outputs, ctx)
        publishRunUpdate(ctx, next.run)
        return { state: next }
      },

      taskBlocked: (state, msg, ctx) => {
        const actorName = state.run.activeTasks[msg.taskId]?.actorName
        if (actorName) ctx.stop({ name: actorName })
        const { [msg.taskId]: _active, ...activeTasks } = state.run.activeTasks
        const run = appendEvent({
          ...state.run,
          status: 'blocked',
          activeTaskIds: state.run.activeTaskIds.filter(id => id !== msg.taskId),
          activeTasks,
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
        publishRunUpdate(ctx, run)
        return { state: { ...state, run } }
      },

      taskFailed: (state, msg, ctx) => {
        const actorName = state.run.activeTasks[msg.taskId]?.actorName
        if (actorName) ctx.stop({ name: actorName })
        const { [msg.taskId]: _active, ...activeTasks } = state.run.activeTasks
        const run = appendEvent({
          ...state.run,
          status: 'failed',
          activeTaskIds: state.run.activeTaskIds.filter(id => id !== msg.taskId),
          activeTasks,
          taskStates: {
            ...state.run.taskStates,
            [msg.taskId]: { ...(state.run.taskStates[msg.taskId] ?? fallbackTaskState()), status: 'failed', error: msg.error },
          },
        }, 'taskFailed', msg.error, msg.taskId)
        publishTerminalJob(ctx, run)
        publishRunUpdate(ctx, run)
        return { state: { ...state, run } }
      },

      _jobRegistry: (state, msg, ctx) => {
        const jobEvent = msg.event
        if ((jobEvent.status === 'completed' || jobEvent.status === 'failed') && state.run.pendingJobs[jobEvent.jobId]) {
          const pending = state.run.pendingJobs[jobEvent.jobId]
          if (!pending) return { state }
          const { [jobEvent.jobId]: _, ...pendingJobs } = state.run.pendingJobs
          const summary = jobEvent.status === 'completed'
            ? jobEvent.result.text
            : `Tool ${pending.toolName} failed: ${jobEvent.error}`
          const withJobCleared = { ...state, run: { ...state.run, pendingJobs } }
          if (jobEvent.status === 'completed') {
            const run = appendEvent({
              ...withJobCleared.run,
              status: 'running',
              taskStates: {
                ...withJobCleared.run.taskStates,
                [pending.taskId]: {
                  ...(withJobCleared.run.taskStates[pending.taskId] ?? fallbackTaskState()),
                  status: 'pending',
                  error: undefined,
                  blockedReason: undefined,
                },
              },
            }, 'taskToolCompleted', `Pending tool ${pending.toolName} completed; retrying task ${pending.taskId}.`, pending.taskId)
            const next = schedule({ ...withJobCleared, run }, ctx, { [pending.taskId]: formatResumeContext(pending.toolName, summary) })
            publishRunUpdate(ctx, next.run)
            return { state: next }
          }
          const failedRun = appendEvent({ ...withJobCleared.run, status: 'failed' }, 'taskFailed', summary, pending.taskId)
          publishTerminalJob(ctx, failedRun)
          publishRunUpdate(ctx, failedRun)
          return { state: { ...withJobCleared, run: failedRun } }
        }
        return { state }
      },

      _done: (state) => ({ state }),
    }),
  }
}
