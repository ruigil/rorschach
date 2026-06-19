
import { relative, resolve, sep } from 'node:path'
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
import { getWorkflowRun, saveWorkflowRun } from './workflow-store.ts'

type RunExecutorState = {
  run: WorkflowRunState
  workflow: Workflow
  tools: ToolCollection
}

const now = (): string => new Date().toISOString()

const isTerminalStatus = (status: string): boolean =>
  status === 'completed' || status === 'failed' || status === 'blocked'

const appendEvent = (run: WorkflowRunState, type: string, message: string, taskId?: string): WorkflowRunState => ({
  ...run,
  events: [...run.events, { timestamp: now(), type, message, ...(taskId ? { taskId } : {}) }],
})

const fallbackTaskState = (): WorkflowTaskRunState => ({ status: 'pending', attempts: 0 })

const toolArtifactRoot = (workflowRunsDir: string, runId: string): string => {
  const workspaceRoot = resolve('workspace')
  const runsRoot = resolve(workflowRunsDir)
  const rel = relative(workspaceRoot, runsRoot)
  if (rel && !rel.startsWith('..') && rel !== '..') return `/workspace/${rel.split(sep).join('/')}/${runId}`
  return `/workspace/workflows/runs/${runId}`
}

const missingExecutionTool = (workflow: Workflow, tools: ToolCollection): string | undefined =>
  workflow.executionTools.find(name => !tools[name])

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

const filterWorkflowTools = (workflow: Workflow, tools: ToolCollection): ToolCollection => {
  const filtered: ToolCollection = {}
  for (const name of workflow.executionTools) {
    const tool = tools[name]
    if (tool) filtered[name] = tool
  }
  return filtered
}

const dependencyOutputs = (run: WorkflowRunState, task: WorkflowTask): Record<string, WorkflowDependencyOutput> =>
  Object.fromEntries(task.dependencies.map(depId => [
    depId,
    {
      ...(run.taskStates[depId]?.summary ? { summary: run.taskStates[depId]?.summary } : {}),
      ...(run.taskStates[depId]?.outputs ? { outputs: run.taskStates[depId]?.outputs } : {}),
    },
  ]))



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
  workflowRunsDir: string,
  llmRef: ActorRef<LlmProviderMsg> | null,
  model: string,
  maxToolLoops: number,
  allTools: ToolCollection,
  userId: string,
  runId: string,
): ActorDef<WorkflowRunExecutorMsg, RunExecutorState> => {

  const runPersistence = (): PersistenceAdapter<RunExecutorState> => ({
    load: async () => {
      const result = await getWorkflowRun(workflowRunsDir, userId, runId)
      if (result.ok) {
        const run = result.data
        const workflow = run.workflow
        const tools = filterWorkflowTools(workflow, allTools)
        return { run, workflow, tools }
      }
      return undefined
    },
    save: async (state) => {
      await saveWorkflowRun(workflowRunsDir, state.run)
    },
  })
  const schedule = (state: RunExecutorState, ctx: ActorContext<WorkflowRunExecutorMsg>): RunExecutorState => {
    if (state.run.status !== 'running') return state
    let run = state.run
    for (const task of readyTasks(state.workflow, run)) {
      const actorName = `workflow-task-${run.runId}-${task.id}-${(run.taskStates[task.id]?.attempts ?? 0) + 1}`
      const child = ctx.spawn(actorName, WorkflowTaskExecutor(ctx.self, llmRef, model, maxToolLoops, state.tools))
      child.send({
        type: 'startTask',
        workflow: state.workflow,
        task,
        inputs: run.inputs,
        artifactRoot: toolArtifactRoot(workflowRunsDir, run.runId),
        dependencyOutputs: dependencyOutputs(run, task),
        history: run.taskStates[task.id]?.history,
        userId: run.userId,
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
    initialState: () => ({ run: null as any, workflow: null as any, tools: {} }),
    persistence: runPersistence(),
    lifecycle: onLifecycle<WorkflowRunExecutorMsg, RunExecutorState>({
      start: (state, ctx) => {
        ctx.subscribe(JobRegistryTopic, jobEvent => ({ type: '_jobRegistry' as const, event: jobEvent }))
        return { state }
      },
    }),
    handler: onMessage<WorkflowRunExecutorMsg, RunExecutorState>({
      start: (state, msg, ctx) => {
        const missingTool = missingExecutionTool(state.workflow, state.tools)
        if (missingTool) {
          const blocked = blockedMissingToolRun(state.run, missingTool)
          publishTerminalJob(ctx, blocked)
          publishRunUpdate(ctx, blocked)
          msg.replyTo.send({ ok: true, run: blocked })
          ctx.stop(ctx.self)
          return { state: { ...state, run: blocked } }
        }
        const next = schedule(state, ctx)
        publishRunUpdate(ctx, next.run)
        if (isTerminalStatus(next.run.status)) {
          ctx.stop(ctx.self)
        }
        msg.replyTo.send({ ok: true, run: next.run })
        return { state: next }
      },

      get: (state, msg, ctx) => {
        if (!state.run) {
          msg.replyTo.send({ ok: false, error: `Workflow run not found: ${runId}`, status: 404 })
          ctx.stop(ctx.self)
          return { state }
        }
        msg.replyTo.send({ ok: true, run: state.run })
        return { state }
      },

      resume: (state, msg, ctx) => {
        if (!state.run) {
          msg.replyTo.send({ ok: false, error: `Workflow run not found: ${runId}`, status: 404 })
          ctx.stop(ctx.self)
          return { state }
        }
        const missingTool = missingExecutionTool(state.workflow, state.tools)
        if (missingTool) {
          const blocked = blockedMissingToolRun(state.run, missingTool)
          publishTerminalJob(ctx, blocked)
          publishRunUpdate(ctx, blocked)
          msg.replyTo.send({ ok: true, run: blocked })
          ctx.stop(ctx.self)
          return { state: { ...state, run: blocked } }
        }
        const next = resumeRun(state, ctx)
        if (!next.ok) {
          msg.replyTo.send(next)
          return { state }
        }
        publishRunUpdate(ctx, next.state.run)
        if (isTerminalStatus(next.state.run.status)) {
          ctx.stop(ctx.self)
        }
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
          taskStates: {
            ...state.run.taskStates,
            [msg.taskId]: {
              ...(state.run.taskStates[msg.taskId] ?? fallbackTaskState()),
              history: msg.history,
            }
          },
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
        if (isTerminalStatus(next.run.status)) {
          ctx.stop(ctx.self)
        }
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
        ctx.stop(ctx.self)
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
        ctx.stop(ctx.self)
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
            const prevHistory = state.run.taskStates[pending.taskId]?.history ?? []
            const updatedHistory = [
              ...prevHistory,
              {
                role: 'tool' as const,
                tool_call_id: pending.toolCallId ?? '',
                content: summary,
              }
            ]
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
                  history: updatedHistory,
                },
              },
            }, 'taskToolCompleted', `Pending tool ${pending.toolName} completed; retrying task ${pending.taskId}.`, pending.taskId)
            const next = schedule({ ...withJobCleared, run }, ctx)
            publishRunUpdate(ctx, next.run)
            if (isTerminalStatus(next.run.status)) {
              ctx.stop(ctx.self)
            }
            return { state: next }
          }
          const failedRun = appendEvent({ ...withJobCleared.run, status: 'failed' }, 'taskFailed', summary, pending.taskId)
          publishTerminalJob(ctx, failedRun)
          publishRunUpdate(ctx, failedRun)
          ctx.stop(ctx.self)
          return { state: { ...withJobCleared, run: failedRun } }
        }
        return { state }
      },

      _done: (state) => ({ state }),
    }),
  }
}
