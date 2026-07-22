import { ask, type ActorRef } from '../../system/index.ts'
import type {
  Workflow,
  WorkflowGraph,
  WorkflowRunState,
  WorkflowSummary,
  WorkflowValueSpec,
  WorkflowTaskRunState,
} from './types.ts'
import { validateWorkflow, validateInputValues } from './validation.ts'
import { type PersistenceMsg, type PResult, type PList } from '../../types/persistence.ts'

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string')

const isWorkflow = (value: unknown): value is Workflow => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj.id === 'string' &&
    typeof obj.userId === 'string' &&
    typeof obj.title === 'string' &&
    typeof obj.goal === 'string' &&
    typeof obj.context === 'string' &&
    typeof obj.createdAt === 'string' &&
    Array.isArray(obj.tasks)
  )
}

const summarize = (workflow: Workflow, filepath: string): WorkflowSummary => ({
  id: workflow.id,
  userId: workflow.userId,
  title: workflow.title,
  goal: workflow.goal,
  createdAt: workflow.createdAt,
  taskCount: workflow.tasks.length,
  filepath,
})

export const toWorkflowGraph = (workflow: Workflow, run?: WorkflowRunState): WorkflowGraph => {
  const dependents = new Map<string, string[]>()
  for (const task of workflow.tasks) {
    for (const dep of task.dependencies) {
      const list = dependents.get(dep) ?? []
      list.push(task.id)
      dependents.set(dep, list)
    }
  }

  return {
    workflow: {
      id: workflow.id,
      userId: workflow.userId,
      title: workflow.title,
      goal: workflow.goal,
      context: workflow.context,
      createdAt: workflow.createdAt,
      taskCount: workflow.tasks.length,
      ...(workflow.inputs ? { inputs: workflow.inputs } : {}),
      ...(workflow.outputs ? { outputs: workflow.outputs } : {}),
    },
    ...(run ? {
      run: {
        runId: run.runId,
        status: run.status,
        inputs: run.inputs ?? {},
        activeTaskIds: run.activeTaskIds,
        activeTasks: run.activeTasks ?? {},
        pendingJobs: run.pendingJobs ?? {},
        outputs: run.outputs ?? {},
        events: run.events ?? [],
      },
    } : {}),
    nodes: workflow.tasks.map(task => {
      const taskState = run?.taskStates[task.id]
      return {
        id: task.id,
        label: task.name,
        description: task.description,
        validationCriteria: task.validationCriteria,
        dependencies: task.dependencies,
        dependents: dependents.get(task.id) ?? [],
        agentMode: task.agentMode,
        ...(task.executionTools ? { executionTools: task.executionTools } : {}),
        status: taskState?.status ?? 'not_tracked',
        ...(taskState?.attempts !== undefined ? { attempts: taskState.attempts } : {}),
        ...(taskState?.startedAt ? { startedAt: taskState.startedAt } : {}),
        ...(taskState?.completedAt ? { completedAt: taskState.completedAt } : {}),
        ...(taskState?.summary ? { summary: taskState.summary } : {}),
        ...(taskState?.outputs ? { outputs: taskState.outputs } : (task.outputs ? { outputs: task.outputs } : {})),
        ...(taskState?.error ? { error: taskState.error } : {}),
        ...(taskState?.blockedReason ? { blockedReason: taskState.blockedReason } : {}),
      }
    }),
    edges: workflow.tasks.flatMap(task =>
      task.dependencies.map(dep => ({
        source: dep,
        target: task.id,
        type: 'depends_on' as const,
      })),
    ),
  }
}

const workflowDocId = (workflowId: string): string =>
  workflowId.endsWith('.json') ? workflowId : `${workflowId}.json`

const readWorkflowFile = async (persistenceRef: ActorRef<any>, workflowId: string): Promise<Workflow | null> => {
  const docId = workflowDocId(workflowId)
  const getRes = await ask<PersistenceMsg, PResult<string>>(persistenceRef, (replyTo) => ({
    type: 'doc.get',
    collection: 'workflows',
    docId,
    replyTo,
  }))

  if (!getRes.ok || !getRes.data) return null
  try {
    const parsed = JSON.parse(getRes.data)
    return isWorkflow(parsed) ? parsed : null
  } catch {
    return null
  }
}

const loadWorkflows = async (persistenceRef: ActorRef<any>, userId: string): Promise<WorkflowSummary[]> => {
  const listRes = await ask<PersistenceMsg, PList>(persistenceRef, (replyTo) => ({
    type: 'doc.list',
    collection: 'workflows',
    replyTo,
  }))
  if (!listRes.ok) return []

  const loaded = await Promise.all(
    listRes.keys.map(async (docId) => {
      const getRes = await ask<PersistenceMsg, PResult<string>>(persistenceRef, (replyTo) => ({
        type: 'doc.get',
        collection: 'workflows',
        docId,
        replyTo,
      }))
      if (!getRes.ok || !getRes.data) return null
      try {
        const parsed = JSON.parse(getRes.data)
        if (!isWorkflow(parsed) || parsed.userId !== userId) return null
        return summarize(parsed, `workflows/${workflowDocId(docId)}`)
      } catch {
        return null
      }
    })
  )

  return loaded
    .filter((w): w is WorkflowSummary => w !== null)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

export type StoreResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number }

export type GetResult = { workflow: Workflow; filepath: string }
export type SaveResult = { workflow: Workflow; filepath: string }
export type UpdateResult = { updated: true; workflow: Workflow; filepath: string }
export type DeleteResult = { deleted: true; workflowId: string }

export const listWorkflows = async (persistenceRef: ActorRef<any>, userId: string): Promise<WorkflowSummary[]> => {
  return loadWorkflows(persistenceRef, userId)
}

export const getWorkflow = async (persistenceRef: ActorRef<any>, userId: string, workflowId: string): Promise<StoreResult<GetResult>> => {
  const docId = workflowDocId(workflowId)
  const parsed = await readWorkflowFile(persistenceRef, workflowId)
  if (!parsed || parsed.userId !== userId) {
    return { ok: false, error: `Workflow not found: ${workflowId}`, status: 404 }
  }
  return { ok: true, data: { workflow: parsed, filepath: `workflows/${docId}` } }
}

export const getWorkflowGraph = async (persistenceRef: ActorRef<any>, userId: string, workflowId: string, run?: WorkflowRunState): Promise<StoreResult<{ graph: WorkflowGraph }>> => {
  const result = await getWorkflow(persistenceRef, userId, workflowId)
  if (!result.ok) return result
  return { ok: true, data: { graph: toWorkflowGraph(result.data.workflow, run) } }
}

export const saveWorkflow = async (persistenceRef: ActorRef<any>, workflow: Workflow): Promise<StoreResult<SaveResult>> => {
  const errors = validateWorkflow(workflow)
  if (errors.length) return { ok: false, error: `Invalid workflow: ${errors.join('; ')}`, status: 400 }

  const docId = workflowDocId(workflow.id)
  await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
    type: 'doc.put',
    collection: 'workflows',
    docId,
    content: JSON.stringify(workflow, null, 2),
    replyTo,
  }))
  return { ok: true, data: { workflow, filepath: `workflows/${docId}` } }
}

export type WorkflowPatch = {
  title?: string
  goal?: string
  context?: string
  inputs?: Record<string, WorkflowValueSpec>
  outputs?: Record<string, WorkflowValueSpec>
  tasks?: Workflow['tasks']
}

export const updateWorkflow = async (persistenceRef: ActorRef<any>, userId: string, workflowId: string, patch: WorkflowPatch): Promise<StoreResult<UpdateResult>> => {
  const found = await getWorkflow(persistenceRef, userId, workflowId)
  if (!found.ok) return found
  const existing = found.data.workflow
  const updated: Workflow = {
    ...existing,
    title: patch.title ?? existing.title,
    goal: patch.goal ?? existing.goal,
    context: patch.context ?? existing.context,
    inputs: patch.inputs ?? existing.inputs,
    outputs: patch.outputs ?? existing.outputs,
    tasks: patch.tasks ?? existing.tasks,
  }
  const errors = validateWorkflow(updated)
  if (errors.length) return { ok: false, error: `Invalid workflow: ${errors.join('; ')}`, status: 400 }

  const docId = workflowDocId(workflowId)
  await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
    type: 'doc.put',
    collection: 'workflows',
    docId,
    content: JSON.stringify(updated, null, 2),
    replyTo,
  }))
  return { ok: true, data: { updated: true, workflow: updated, filepath: `workflows/${docId}` } }
}

export const deleteWorkflow = async (persistenceRef: ActorRef<any>, userId: string, workflowId: string): Promise<StoreResult<DeleteResult>> => {
  const found = await getWorkflow(persistenceRef, userId, workflowId)
  if (!found.ok) return found

  const docId = workflowDocId(workflowId)
  await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
    type: 'doc.delete',
    collection: 'workflows',
    docId,
    replyTo,
  }))

  return { ok: true, data: { deleted: true, workflowId } }
}

export const withRunDefaults = (run: WorkflowRunState): WorkflowRunState => ({
  ...run,
  inputs: run.inputs ?? {},
  outputs: run.outputs ?? {},
})

const readRunFile = async (persistenceRef: ActorRef<any>, runId: string): Promise<WorkflowRunState | null> => {
  const docId = runId.endsWith('.json') ? runId : `${runId}.json`
  const res = await ask<PersistenceMsg, PResult<string>>(persistenceRef, (replyTo) => ({
    type: 'doc.get',
    collection: 'workflow-runs',
    docId,
    replyTo,
  }))
  if (!res.ok || !res.data) return null
  try {
    const parsed = JSON.parse(res.data) as WorkflowRunState
    return parsed && typeof parsed.runId === 'string' && typeof parsed.userId === 'string'
      ? withRunDefaults(parsed)
      : null
  } catch {
    return null
  }
}

export const listWorkflowRuns = async (persistenceRef: ActorRef<any>, userId: string): Promise<WorkflowRunState[]> => {
  const listRes = await ask<PersistenceMsg, PList>(persistenceRef, (replyTo) => ({
    type: 'doc.list',
    collection: 'workflow-runs',
    replyTo,
  }))
  if (!listRes.ok) return []

  const loaded = await Promise.all(
    listRes.keys.map(async (runId) => readRunFile(persistenceRef, runId))
  )

  return loaded
    .filter((run): run is WorkflowRunState => run !== null && run.userId === userId)
    .sort((a, b) => (b.events[0]?.timestamp ?? '').localeCompare(a.events[0]?.timestamp ?? ''))
}

export const getWorkflowRun = async (persistenceRef: ActorRef<any>, userId: string, runId: string): Promise<StoreResult<WorkflowRunState>> => {
  const run = await readRunFile(persistenceRef, runId)
  if (!run || run.userId !== userId) {
    return { ok: false, error: `Workflow run not found: ${runId}`, status: 404 }
  }
  return { ok: true, data: run }
}

export const deleteWorkflowRun = async (persistenceRef: ActorRef<any>, userId: string, runId: string): Promise<StoreResult<{ deleted: true; runId: string }>> => {
  const found = await getWorkflowRun(persistenceRef, userId, runId)
  if (!found.ok) return found

  const docId = runId.endsWith('.json') ? runId : `${runId}.json`
  await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
    type: 'doc.delete',
    collection: 'workflow-runs',
    docId,
    replyTo,
  }))

  return { ok: true, data: { deleted: true, runId } }
}

export const saveWorkflowRun = async (persistenceRef: ActorRef<any>, run: WorkflowRunState): Promise<StoreResult<WorkflowRunState>> => {
  try {
    await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
      type: 'doc.put',
      collection: 'workflow-runs',
      docId: `${run.runId}.json`,
      content: JSON.stringify(run, null, 2),
      replyTo,
    }))
    return { ok: true, data: run }
  } catch (err) {
    return { ok: false, error: `Failed to save workflow run: ${String(err)}`, status: 500 }
  }
}

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
  events: [{ timestamp: new Date().toISOString(), type: 'runStarted', message: `Workflow run ${runId} started.` }],
  workflow,
})

export const createWorkflowRun = async (
  persistenceRef: ActorRef<any>,
  userId: string,
  workflowId: string,
  inputs: Record<string, unknown> | undefined,
): Promise<StoreResult<{ run: WorkflowRunState; workflow: Workflow }>> => {
  const workflowResult = await getWorkflow(persistenceRef, userId, workflowId)
  if (!workflowResult.ok) return workflowResult

  const inputValidation = validateInputValues(workflowResult.data.workflow.inputs, inputs)
  if (!inputValidation.ok) return { ok: false, error: inputValidation.error, status: 400 }

  const run = initialRunState(workflowResult.data.workflow, crypto.randomUUID(), inputValidation.values)

  const saveResult = await saveWorkflowRun(persistenceRef, run)
  if (!saveResult.ok) return saveResult

  return { ok: true, data: { run, workflow: workflowResult.data.workflow } }
}
