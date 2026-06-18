import { mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  Workflow,
  WorkflowGraph,
  WorkflowRunState,
  WorkflowSummary,
  WorkflowValueSpec,
  WorkflowTaskRunState,
} from './types.ts'
import { validateWorkflow, validateInputValues } from './validation.ts'

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string')

const isWorkflow = (value: unknown): value is Workflow => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj.id === 'string' &&
    typeof obj.userId === 'string' &&
    typeof obj.goal === 'string' &&
    typeof obj.context === 'string' &&
    typeof obj.createdAt === 'string' &&
    isStringArray(obj.executionTools) &&
    Array.isArray(obj.tasks)
  )
}

const readWorkflowFile = async (filepath: string): Promise<Workflow | null> => {
  try {
    const parsed = JSON.parse(await Bun.file(filepath).text()) as unknown
    return isWorkflow(parsed) ? parsed : null
  } catch {
    return null
  }
}

const listWorkflowFiles = async (workflowsDir: string): Promise<string[]> => {
  try {
    const entries = await readdir(workflowsDir, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => join(workflowsDir, entry.name))
  } catch {
    return []
  }
}

const summarize = (workflow: Workflow, filepath: string): WorkflowSummary => ({
  id: workflow.id,
  userId: workflow.userId,
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
      goal: workflow.goal,
      context: workflow.context,
      createdAt: workflow.createdAt,
      taskCount: workflow.tasks.length,
      executionTools: workflow.executionTools,
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
        status: taskState?.status ?? 'not_tracked',
        ...(taskState?.attempts !== undefined ? { attempts: taskState.attempts } : {}),
        ...(taskState?.startedAt ? { startedAt: taskState.startedAt } : {}),
        ...(taskState?.completedAt ? { completedAt: taskState.completedAt } : {}),
        ...(taskState?.summary ? { summary: taskState.summary } : {}),
        ...(taskState?.outputs ? { outputs: taskState.outputs } : {}),
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

const loadWorkflows = async (workflowsDir: string, userId: string): Promise<Array<{ workflow: Workflow; filepath: string }>> => {
  const files = await listWorkflowFiles(workflowsDir)
  const loaded = await Promise.all(files.map(async filepath => ({ filepath, workflow: await readWorkflowFile(filepath) })))
  return loaded
    .filter((entry): entry is { filepath: string; workflow: Workflow } => entry.workflow !== null && entry.workflow.userId === userId)
    .sort((a, b) => Date.parse(b.workflow.createdAt) - Date.parse(a.workflow.createdAt))
}

export type StoreResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number }

export type GetResult = { workflow: Workflow; filepath: string }
export type SaveResult = { workflow: Workflow; filepath: string }
export type UpdateResult = { updated: true; workflow: Workflow; filepath: string }
export type DeleteResult = { deleted: true; workflowId: string }

export async function listWorkflows(workflowsDir: string, userId: string): Promise<WorkflowSummary[]> {
  const entries = await loadWorkflows(workflowsDir, userId)
  return entries.map(entry => summarize(entry.workflow, entry.filepath))
}

export async function getWorkflow(workflowsDir: string, userId: string, workflowId: string): Promise<StoreResult<GetResult>> {
  const workflows = await loadWorkflows(workflowsDir, userId)
  const found = workflows.find(entry => entry.workflow.id === workflowId)
  if (!found) return { ok: false, error: `Workflow not found: ${workflowId}`, status: 404 }
  return { ok: true, data: { workflow: found.workflow, filepath: found.filepath } }
}

export async function getWorkflowGraph(workflowsDir: string, userId: string, workflowId: string, run?: WorkflowRunState): Promise<StoreResult<{ graph: WorkflowGraph }>> {
  const result = await getWorkflow(workflowsDir, userId, workflowId)
  if (!result.ok) return result
  return { ok: true, data: { graph: toWorkflowGraph(result.data.workflow, run) } }
}

const workflowFilename = (workflow: Workflow): string => {
  const date = workflow.createdAt.slice(0, 10)
  const slug = workflow.goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
  return `${date}-${slug || 'workflow'}-${workflow.id.slice(0, 8)}.json`
}

export async function saveWorkflow(workflowsDir: string, workflow: Workflow): Promise<StoreResult<SaveResult>> {
  const errors = validateWorkflow(workflow)
  if (errors.length) return { ok: false, error: `Invalid workflow: ${errors.join('; ')}`, status: 400 }
  await mkdir(workflowsDir, { recursive: true })
  const filepath = join(workflowsDir, workflowFilename(workflow))
  await Bun.write(filepath, JSON.stringify(workflow, null, 2))
  return { ok: true, data: { workflow, filepath } }
}

export type WorkflowPatch = {
  goal?: string
  context?: string
  executionTools?: string[]
  inputs?: Record<string, WorkflowValueSpec>
  outputs?: Record<string, WorkflowValueSpec>
  tasks?: Workflow['tasks']
}

// Mutations (save/update/delete) are only called from the workflows agent tool handler,
// which serializes turns via the agent loop. There is no concurrent writer — if a second
// mutation path is added (e.g. an HTTP PUT route), the read-then-write in updateWorkflow
// will need serialization or atomic writes to avoid lost updates.
export async function updateWorkflow(workflowsDir: string, userId: string, workflowId: string, patch: WorkflowPatch): Promise<StoreResult<UpdateResult>> {
  const found = await getWorkflow(workflowsDir, userId, workflowId)
  if (!found.ok) return found
  const existing = found.data.workflow
  const updated: Workflow = {
    ...existing,
    goal: patch.goal ?? existing.goal,
    context: patch.context ?? existing.context,
    executionTools: patch.executionTools ?? existing.executionTools,
    inputs: patch.inputs ?? existing.inputs,
    outputs: patch.outputs ?? existing.outputs,
    tasks: patch.tasks ?? existing.tasks,
  }
  const errors = validateWorkflow(updated)
  if (errors.length) return { ok: false, error: `Invalid workflow: ${errors.join('; ')}`, status: 400 }
  await Bun.write(found.data.filepath, JSON.stringify(updated, null, 2))
  return { ok: true, data: { updated: true, workflow: updated, filepath: found.data.filepath } }
}

export async function deleteWorkflow(workflowsDir: string, userId: string, workflowId: string): Promise<StoreResult<DeleteResult>> {
  const found = await getWorkflow(workflowsDir, userId, workflowId)
  if (!found.ok) return found
  await unlink(found.data.filepath)
  return { ok: true, data: { deleted: true, workflowId } }
}

const withRunDefaults = (run: WorkflowRunState): WorkflowRunState => ({
  ...run,
  inputs: run.inputs ?? {},
  outputs: run.outputs ?? {},
})

const readRunFile = async (filepath: string): Promise<WorkflowRunState | null> => {
  try {
    const parsed = JSON.parse(await Bun.file(filepath).text()) as WorkflowRunState
    return parsed && typeof parsed.runId === 'string' && typeof parsed.userId === 'string'
      ? withRunDefaults(parsed)
      : null
  } catch {
    return null
  }
}

export async function listWorkflowRuns(workflowRunsDir: string, userId: string): Promise<WorkflowRunState[]> {
  try {
    const entries = await readdir(workflowRunsDir, { withFileTypes: true })
    const loaded = await Promise.all(entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => readRunFile(join(workflowRunsDir, entry.name))))
    return loaded
      .filter((run): run is WorkflowRunState => run !== null && run.userId === userId)
      .sort((a, b) => (b.events[0]?.timestamp ?? '').localeCompare(a.events[0]?.timestamp ?? ''))
  } catch {
    return []
  }
}

export async function getWorkflowRun(workflowRunsDir: string, userId: string, runId: string): Promise<StoreResult<WorkflowRunState>> {
  const filepath = join(workflowRunsDir, `${runId}.json`)
  const run = await readRunFile(filepath)
  if (!run || run.userId !== userId) {
    return { ok: false, error: `Workflow run not found: ${runId}`, status: 404 }
  }
  return { ok: true, data: run }
}

export async function saveWorkflowRun(workflowRunsDir: string, run: WorkflowRunState): Promise<StoreResult<WorkflowRunState>> {
  try {
    await mkdir(workflowRunsDir, { recursive: true })
    const filepath = join(workflowRunsDir, `${run.runId}.json`)
    await Bun.write(filepath, JSON.stringify(run, null, 2))
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

export async function createWorkflowRun(
  workflowsDir: string,
  workflowRunsDir: string,
  userId: string,
  workflowId: string,
  inputs: Record<string, unknown> | undefined,
): Promise<StoreResult<{ run: WorkflowRunState; workflow: Workflow }>> {
  const workflowResult = await getWorkflow(workflowsDir, userId, workflowId)
  if (!workflowResult.ok) return workflowResult

  const inputValidation = validateInputValues(workflowResult.data.workflow.inputs, inputs)
  if (!inputValidation.ok) return { ok: false, error: inputValidation.error, status: 400 }

  const run = initialRunState(workflowResult.data.workflow, crypto.randomUUID(), inputValidation.values)

  const saveResult = await saveWorkflowRun(workflowRunsDir, run)
  if (!saveResult.ok) return saveResult

  const runArtifactDir = join(workflowRunsDir, run.runId)
  await mkdir(runArtifactDir, { recursive: true })

  return { ok: true, data: { run, workflow: workflowResult.data.workflow } }
}