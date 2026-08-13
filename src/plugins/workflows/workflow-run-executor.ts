
import type { ActorContext, ActorDef, ActorRef, PersistenceAdapter } from '../../system/index.ts'
import { onLifecycle, onMessage, persistencePluginAdapter } from '../../system/index.ts'
import { JobRegistryTopic, type ToolCollection, type ToolReply } from '../../types/tools.ts'
import { LlmProviderTopic, type LlmProviderMsg } from '../../types/llm.ts'
import { WorkflowEventTopic } from './types.ts'
import type {
  Workflow,
  WorkflowDependencyOutput,
  WorkflowRunExecutorReply,
  WorkflowRunExecutorMsg,
  WorkflowRunState,
  WorkflowTask,
  WorkflowTaskRunState,
  WorkflowOutputValue,
} from './types.ts'
import { WorkflowTaskExecutor } from './workflow-task-executor.ts'
import { validateOutputValues } from './validation.ts'
import { getWorkflowRun, saveWorkflowRun, createWorkflowRun } from './workflow-store.ts'
import { resolvePersistence } from '../../system/index.ts'

import type { PermissionContext } from '../../system/permissions/types.ts'
import { ResolutionCache } from '../../system/scr/cache.ts'
import type { SCRReply } from '../../types/scr.ts'
import type { MessageRequest } from '../../system/context/request.ts'
import { PersistenceProviderTopic, type PersistenceMsg } from '../../types/persistence.ts'

type RunExecutorState = {
  run: WorkflowRunState
  workflow: Workflow
  tools: ToolCollection
  llmRef: ActorRef<LlmProviderMsg> | null
  permissionContext: PermissionContext
}

const now = (): string => new Date().toISOString()

const isTerminalStatus = (status: string): boolean =>
  status === 'completed' || status === 'failed' || status === 'blocked'

const appendEvent = (run: WorkflowRunState, type: string, message: string, taskId?: string): WorkflowRunState => ({
  ...run,
  events: [...run.events, { timestamp: now(), type, message, ...(taskId ? { taskId } : {}) }],
})

const fallbackTaskState = (): WorkflowTaskRunState => ({ status: 'pending', attempts: 0 })

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
  ctx.publish(WorkflowEventTopic, {
    userId: run.userId,
    workflowId: run.workflowId,
    runId: run.runId,
    run,
  })
}

export const WorkflowRunExecutor = (
  llmRef: ActorRef<LlmProviderMsg> | null,
  model: string,
  maxToolLoops: number,
  allTools: ToolCollection,
  userId: string,
  runId: string,
  permissionContext: PermissionContext = { grants: ['*'] },
): ActorDef<WorkflowRunExecutorMsg, RunExecutorState> => {

  const runPersistence = (): PersistenceAdapter<RunExecutorState> => ({
    load: async (services) => {
      const dl = await resolvePersistence(services)
      const result = await getWorkflowRun(dl, userId, runId)
      if (result.ok) {
        const run = result.data
        const workflow = run.workflow
        return { run, workflow, tools: allTools, llmRef, permissionContext }
      }
      return undefined
    },
    save: async (state, services) => {
      const dl = await resolvePersistence(services)
      await saveWorkflowRun(dl, state.run)
    },
  })
  const schedule = (state: RunExecutorState, ctx: ActorContext<WorkflowRunExecutorMsg>): RunExecutorState => {
    if (state.run.status !== 'running') return state
    let run = state.run
    for (const task of readyTasks(state.workflow, run)) {
      const actorName = `workflow-task-${run.runId}-${task.id}-${(run.taskStates[task.id]?.attempts ?? 0) + 1}`
      const child = ctx.spawn(actorName, WorkflowTaskExecutor(ctx.self, state.llmRef, model, maxToolLoops, state.tools, state.permissionContext))
      child.send({
        type: 'startTask',
        runId: state.run.runId,
        workflow: state.workflow,
        task,
        inputs: run.inputs,
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
    initialState: () => ({ run: null as any, workflow: null as any, tools: {}, llmRef, permissionContext }),
    persistence: runPersistence(),
    lifecycle: onLifecycle<WorkflowRunExecutorMsg, RunExecutorState>({
      start: (state, ctx) => {
        ctx.subscribe(LlmProviderTopic, event => ({ type: '_llmProvider' as const, ref: event.ref }))
        ctx.subscribe(JobRegistryTopic, jobEvent => ({ type: '_jobRegistry' as const, event: jobEvent }))
        return { state }
      },
    }),
    handler: onMessage<WorkflowRunExecutorMsg, RunExecutorState>({
      _llmProvider: (state, msg) => {
        return { state: { ...state, llmRef: msg.ref } }
      },

      start: (state, msg, ctx) => {
        const next = schedule(state, ctx)
        publishRunUpdate(ctx, next.run)
        if (isTerminalStatus(next.run.status)) {
          publishTerminalJob(ctx, next.run)
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
        const next = resumeRun(state, ctx)
        if (!next.ok) {
          msg.replyTo.send(next)
          return { state }
        }
        publishRunUpdate(ctx, next.state.run)
        if (isTerminalStatus(next.state.run.status)) {
          publishTerminalJob(ctx, next.state.run)
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
        const next = schedule({ ...state, run }, ctx)
        publishRunUpdate(ctx, next.run)
        if (isTerminalStatus(next.run.status)) {
          publishTerminalJob(ctx, next.run)
          ctx.stop(ctx.self)
        }
        return { state: next }
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

export type SCRWorkflowRunnerOptions = {
  runId: string
  workflowId: string
  urn: string
  input: any
  replyTo: ActorRef<SCRReply>
  llmRef: ActorRef<LlmProviderMsg> | null
  spawnerRef: ActorRef<any>
  request: MessageRequest
  model: string
  maxToolLoops: number
}

const getExecutionTools = (): ToolCollection => {
  const tools: ToolCollection = {}
  const descriptors = ResolutionCache.getAllDescriptors()
  for (const desc of descriptors) {
    if (desc.kind === 'leaf') {
      const name = desc.meta?.schema?.function?.name || desc.urn.split('.').pop() || ''
      tools[name] = {
        name,
        schema: desc.meta?.schema || {
          type: 'function',
          function: {
            name,
            description: desc.description,
            parameters: desc.schema.inputSchema || {},
          }
        },
        ref: desc.target,
      }
    }
  }
  return tools
}

export const SCRWorkflowRunner = (opts: SCRWorkflowRunnerOptions): ActorDef<any, any> => {
  const { runId, workflowId, urn, input, replyTo, spawnerRef, request, model, maxToolLoops } = opts

  const scheduleSCR = (state: any, ctx: ActorContext<any>): any => {
    if (state.run.status !== 'running') return state
    let run = state.run
    for (const task of readyTasks(state.workflow, run)) {
      const actorName = `workflow-task-${run.runId}-${task.id}-${(run.taskStates[task.id]?.attempts ?? 0) + 1}`
      const child = ctx.spawn(actorName, WorkflowTaskExecutor(ctx.self, state.llmRef, model, maxToolLoops, state.tools, state.permissionContext))
      child.send({
        type: 'startTask',
        runId: state.run.runId,
        workflow: state.workflow,
        task,
        inputs: run.inputs,
        dependencyOutputs: dependencyOutputs(run, task),
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
            startedAt: now(),
            attempts: (run.taskStates[task.id]?.attempts ?? 0) + 1,
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

  const completeTaskSCR = (state: any, taskId: string, summary: string, outputs: Record<string, WorkflowOutputValue>, ctx: ActorContext<any>): any => {
    const actorName = state.run.activeTasks[taskId]?.actorName
    if (actorName) ctx.stop({ name: actorName })
    const { [taskId]: _active, ...activeTasks } = state.run.activeTasks
    const run = appendEvent({
      ...state.run,
      activeTaskIds: state.run.activeTaskIds.filter((id: string) => id !== taskId),
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
    const next = scheduleSCR({ ...state, run }, ctx)
    if (next.run.status !== run.status) publishTerminalJob(ctx, next.run)
    return next
  }

  return {
    initialState: () => ({
      runId,
      workflowId,
      urn,
      input,
      replyTo,
      spawnerRef,
      originalRequest: request,
      run: null,
      workflow: null,
      llmRef: opts.llmRef,
      persistenceRef: null,
      tools: {},
      permissionContext: { grants: ['*'] },
    }),

    persistence: persistencePluginAdapter<any>(`scr.run.${runId}`),

    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(PersistenceProviderTopic, (event) => ({
          type: '_persistenceRef' as const,
          ref: event.ref,
        }))

        ctx.subscribe(LlmProviderTopic, (event) => ({
          type: '_llmProvider' as const,
          ref: event.ref,
        }))

        if (state.run === null) {
          ctx.send(ctx.self, { type: 'start' }, state.originalRequest)
        }
        return { state }
      },
    }),

    handler: onMessage({
      start: (state, msg, ctx) => {
        if (!state.persistenceRef) {
          return { state, stash: true }
        }

        state.tools = getExecutionTools()

        const req = state.originalRequest || ctx.request
        const userId = req?.userId || 'system'
        const permissionContext = req?.permission || { grants: ['*'] }
        state.permissionContext = permissionContext

        if (state.input !== null) {
          ctx.pipeToSelf(
            createWorkflowRun(state.persistenceRef, userId, state.workflowId, state.input),
            (res) => ({ type: '_runCreated' as const, result: res }),
            (err) => ({ type: '_runCreated' as const, result: { ok: false, error: String(err), status: 500 } })
          )
        } else {
          ctx.pipeToSelf(
            getWorkflowRun(state.persistenceRef, userId, state.runId),
            (res) => ({ type: '_runLoaded' as const, result: res }),
            (err) => ({ type: '_runLoaded' as const, result: { ok: false, error: String(err), status: 500 } })
          )
        }
        return { state }
      },

      _runCreated: (state, msg, ctx) => {
        const { result } = msg
        if (!result.ok) {
          if (state.replyTo) {
            state.replyTo.send({
              type: 'error',
              error: result.error,
            })
          }
          ctx.stop(ctx.self)
          return { state }
        }
        state.run = result.data.run
        state.workflow = result.data.workflow
        state.run.status = 'running'

        const next = scheduleSCR(state, ctx)
        publishRunUpdate(ctx, next.run)
        if (isTerminalStatus(next.run.status)) {
          publishTerminalJob(ctx, next.run)
          if (state.replyTo) {
            state.replyTo.send({
              type: 'result',
              output: next.run.outputs,
            })
          }
          saveWorkflowRun(state.persistenceRef, next.run)
          state.persistenceRef.send({
            type: 'kv.delete',
            key: `scr.run.${state.runId}`,
          })
          ctx.stop(ctx.self)
          return { state: next }
        }
        saveWorkflowRun(state.persistenceRef, next.run)
        return { state: next }
      },

      _runLoaded: (state, msg) => {
        const { result } = msg
        if (!result.ok) {
          if (state.replyTo) {
            state.replyTo.send({
              type: 'error',
              error: result.error,
            })
          }
          return { state }
        }
        state.run = result.data
        state.workflow = result.data.workflow
        return { state }
      },

      taskCompleted: (state, msg, ctx) => {
        if (!state.run) return { state }
        const next = completeTaskSCR(state, msg.taskId, msg.summary, msg.outputs, ctx)
        publishRunUpdate(ctx, next.run)
        if (state.persistenceRef) {
          saveWorkflowRun(state.persistenceRef, next.run)
        }
        if (isTerminalStatus(next.run.status)) {
          if (state.replyTo) {
            if (next.run.status === 'completed') {
              state.replyTo.send({
                type: 'result',
                output: next.run.outputs,
              })
            } else {
              state.replyTo.send({
                type: 'error',
                error: `Workflow run failed.`,
              })
            }
          }
          if (state.persistenceRef) {
            state.persistenceRef.send({
              type: 'kv.delete',
              key: `scr.run.${state.runId}`,
            })
          }
          ctx.stop(ctx.self)
        }
        return { state: next }
      },

      taskFailed: (state, msg, ctx) => {
        if (!state.run) return { state }
        const actorName = state.run.activeTasks[msg.taskId]?.actorName
        if (actorName) ctx.stop({ name: actorName })
        const { [msg.taskId]: _active, ...activeTasks } = state.run.activeTasks
        const run = appendEvent({
          ...state.run,
          status: 'failed',
          activeTaskIds: state.run.activeTaskIds.filter((id: string) => id !== msg.taskId),
          activeTasks,
          taskStates: {
            ...state.run.taskStates,
            [msg.taskId]: { ...(state.run.taskStates[msg.taskId] ?? fallbackTaskState()), status: 'failed', error: msg.error },
          },
        }, 'taskFailed', msg.error, msg.taskId)
        publishTerminalJob(ctx, run)
        publishRunUpdate(ctx, run)
        if (state.persistenceRef) {
          saveWorkflowRun(state.persistenceRef, run)
          state.persistenceRef.send({
            type: 'kv.delete',
            key: `scr.run.${state.runId}`,
          })
        }
        if (state.replyTo) {
          state.replyTo.send({
            type: 'error',
            error: msg.error,
          })
        }
        ctx.stop(ctx.self)
        return { state: { ...state, run } }
      },

      taskBlocked: (state, msg, ctx) => {
        if (!state.run) return { state }
        const actorName = state.run.activeTasks[msg.taskId]?.actorName
        if (actorName) ctx.stop({ name: actorName })
        const { [msg.taskId]: _active, ...activeTasks } = state.run.activeTasks
        const run = appendEvent({
          ...state.run,
          activeTaskIds: state.run.activeTaskIds.filter((id: string) => id !== msg.taskId),
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
        const next = scheduleSCR({ ...state, run }, ctx)
        publishRunUpdate(ctx, next.run)
        if (state.persistenceRef) {
          saveWorkflowRun(state.persistenceRef, next.run)
        }
        if (isTerminalStatus(next.run.status)) {
          publishTerminalJob(ctx, next.run)
          if (state.replyTo) {
            state.replyTo.send({
              type: 'error',
              error: `Workflow run blocked: ${msg.message}`,
            })
          }
          if (state.persistenceRef) {
            state.persistenceRef.send({
              type: 'kv.delete',
              key: `scr.run.${state.runId}`,
            })
          }
          ctx.stop(ctx.self)
        }
        return { state: next }
      },

      taskWaiting: (state, msg, ctx) => {
        if (!state.run) return { state }
        const actorName = state.run.activeTasks[msg.taskId]?.actorName
        if (actorName) ctx.stop({ name: actorName })
        const { [msg.taskId]: _active, ...activeTasks } = state.run.activeTasks
        const run = appendEvent({
          ...state.run,
          activeTaskIds: state.run.activeTaskIds.filter((id: string) => id !== msg.taskId),
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

        if (state.persistenceRef) {
          saveWorkflowRun(state.persistenceRef, run)
        }

        // Register job with WorkflowManager
        state.spawnerRef.send({
          type: 'registerJob',
          jobId: msg.jobId,
          runId: state.runId,
          urn: state.urn,
        })

        if (state.replyTo) {
          state.replyTo.send({
            type: 'pending',
            jobId: msg.jobId,
            placeholderText: `Workflow run is waiting for job completion: ${msg.jobId}`,
          })
        }

        ctx.stop(ctx.self)
        return { state: { ...state, run } }
      },

      _jobCompleted: (state, msg, ctx) => {
        if (!state.run) return { state }
        const { jobId, reply } = msg
        const pending = state.run.pendingJobs[jobId]
        if (!pending) return { state }

        const { [jobId]: _, ...pendingJobs } = state.run.pendingJobs
        const nextRun = { ...state.run, pendingJobs }

        if (reply.type === 'toolResult') {
          const summary = reply.result.text
          let outputs = reply.result.outputs ?? {}
          if (Object.keys(outputs).length === 0 && reply.result.text) {
            try {
              const parsed = JSON.parse(reply.result.text)
              if (parsed && typeof parsed === 'object') {
                outputs = parsed
              }
            } catch {}
          }

          if (pending.toolName && pending.toolName.startsWith('SCR:')) {
            // SCR Task Resumption: complete the task directly!
            const next = completeTaskSCR(state, pending.taskId, summary, outputs, ctx)
            publishRunUpdate(ctx, next.run)
            if (state.persistenceRef) {
              saveWorkflowRun(state.persistenceRef, next.run)
            }
            if (isTerminalStatus(next.run.status)) {
              if (state.replyTo) {
                state.replyTo.send({
                  type: 'result',
                  output: next.run.outputs,
                })
              }
              if (state.persistenceRef) {
                state.persistenceRef.send({
                  type: 'kv.delete',
                  key: `scr.run.${state.runId}`,
                })
              }
              ctx.stop(ctx.self)
            }
            return { state: next }
          } else {
            // Legacy ReAct Task Resumption: mark pending and retry
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
              ...nextRun,
              status: 'running',
              taskStates: {
                ...nextRun.taskStates,
                [pending.taskId]: {
                  ...(nextRun.taskStates[pending.taskId] ?? fallbackTaskState()),
                  status: 'pending',
                  error: undefined,
                  blockedReason: undefined,
                  history: updatedHistory,
                },
              },
            }, 'taskToolCompleted', `Pending job completed; retrying task ${pending.taskId}.`, pending.taskId)
            const next = scheduleSCR({ ...state, run }, ctx)
            publishRunUpdate(ctx, next.run)
            if (state.persistenceRef) {
              saveWorkflowRun(state.persistenceRef, next.run)
            }
            if (isTerminalStatus(next.run.status)) {
              if (state.replyTo) {
                state.replyTo.send({
                  type: 'result',
                  output: next.run.outputs,
                })
              }
              if (state.persistenceRef) {
                state.persistenceRef.send({
                  type: 'kv.delete',
                  key: `scr.run.${state.runId}`,
                })
              }
              ctx.stop(ctx.self)
            }
            return { state: next }
          }
        } else {
          const error = reply.error ?? 'Job failed.'
          const failedRun = appendEvent({ ...nextRun, status: 'failed' }, 'taskFailed', error, pending.taskId)
          publishTerminalJob(ctx, failedRun)
          publishRunUpdate(ctx, failedRun)
          if (state.persistenceRef) {
            saveWorkflowRun(state.persistenceRef, failedRun)
            state.persistenceRef.send({
              type: 'kv.delete',
              key: `scr.run.${state.runId}`,
            })
          }
          if (state.replyTo) {
            state.replyTo.send({
              type: 'error',
              error,
            })
          }
          ctx.stop(ctx.self)
          return { state: { ...state, run: failedRun } }
        }
      },

      _persistenceRef: (state, msg) => {
        return { state: { ...state, persistenceRef: msg.ref } }
      },

      _llmProvider: (state, msg) => {
        return { state: { ...state, llmRef: msg.ref } }
      },
    }),
  }
}


