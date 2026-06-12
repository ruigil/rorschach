import { mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActorDef } from '../../system/index.ts'
import { onMessage } from '../../system/index.ts'
import type {
  Workflow,
  WorkflowGraph,
  WorkflowRunState,
  WorkflowStoreMsg,
  WorkflowStoreReply,
  WorkflowSummary,
} from './types.ts'
import { validateWorkflow } from './validation.ts'

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

const getWorkflow = async (workflowsDir: string, userId: string, workflowId: string): Promise<WorkflowStoreReply> => {
  const workflows = await loadWorkflows(workflowsDir, userId)
  const found = workflows.find(entry => entry.workflow.id === workflowId)
  if (!found) return { ok: false, error: `Workflow not found: ${workflowId}`, status: 404 }
  return { ok: true, workflow: found.workflow, filepath: found.filepath }
}

const workflowFilename = (workflow: Workflow): string => {
  const date = workflow.createdAt.slice(0, 10)
  const slug = workflow.goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
  return `${date}-${slug || 'workflow'}-${workflow.id.slice(0, 8)}.json`
}

export const WorkflowStore = (workflowsDir: string): ActorDef<WorkflowStoreMsg, null> => ({
  initialState: null,
  handler: onMessage<WorkflowStoreMsg, null>({
    _done: (state) => ({ state }),

    list: (state, msg, ctx) => {
      ctx.pipeToSelf(
        loadWorkflows(workflowsDir, msg.userId).then(workflows => ({ ok: true as const, workflows: workflows.map(entry => summarize(entry.workflow, entry.filepath)) })),
        reply => {
          msg.replyTo.send(reply)
          return { type: '_done' }
        },
        error => {
          msg.replyTo.send({ ok: false, error: String(error) })
          return { type: '_done' }
        },
      )
      return { state }
    },

    get: (state, msg, ctx) => {
      ctx.pipeToSelf(
        getWorkflow(workflowsDir, msg.userId, msg.workflowId),
        reply => {
          msg.replyTo.send(reply)
          return { type: '_done' }
        },
        error => {
          msg.replyTo.send({ ok: false, error: String(error) })
          return { type: '_done' }
        },
      )
      return { state }
    },

    graph: (state, msg, ctx) => {
      ctx.pipeToSelf(
        getWorkflow(workflowsDir, msg.userId, msg.workflowId).then(reply => {
          if (!reply.ok || !('workflow' in reply)) return reply
          return { ok: true as const, graph: toWorkflowGraph(reply.workflow, msg.run) }
        }),
        reply => {
          msg.replyTo.send(reply)
          return { type: '_done' }
        },
        error => {
          msg.replyTo.send({ ok: false, error: String(error) })
          return { type: '_done' }
        },
      )
      return { state }
    },

    save: (state, msg, ctx) => {
      ctx.pipeToSelf(
        (async () => {
          const errors = validateWorkflow(msg.workflow)
          if (errors.length) return { ok: false as const, error: `Invalid workflow: ${errors.join('; ')}`, status: 400 }
          await mkdir(workflowsDir, { recursive: true })
          const filepath = join(workflowsDir, workflowFilename(msg.workflow))
          await Bun.write(filepath, JSON.stringify(msg.workflow, null, 2))
          return { ok: true as const, workflow: msg.workflow, filepath }
        })(),
        reply => {
          msg.replyTo.send(reply)
          return { type: '_done' }
        },
        error => {
          msg.replyTo.send({ ok: false, error: String(error) })
          return { type: '_done' }
        },
      )
      return { state }
    },

    update: (state, msg, ctx) => {
      ctx.pipeToSelf(
        (async () => {
          const found = await getWorkflow(workflowsDir, msg.userId, msg.workflowId)
          if (!found.ok || !('workflow' in found)) return found
          const existing = found.workflow
          const updated: Workflow = {
            ...existing,
            goal: msg.patch.goal ?? existing.goal,
            context: msg.patch.context ?? existing.context,
            executionTools: msg.patch.executionTools ?? existing.executionTools,
            inputs: msg.patch.inputs ?? existing.inputs,
            outputs: msg.patch.outputs ?? existing.outputs,
            tasks: msg.patch.tasks ?? existing.tasks,
          }
          const errors = validateWorkflow(updated)
          if (errors.length) return { ok: false as const, error: `Invalid workflow: ${errors.join('; ')}`, status: 400 }
          await Bun.write(found.filepath, JSON.stringify(updated, null, 2))
          return { ok: true as const, updated: true as const, workflow: updated, filepath: found.filepath }
        })(),
        reply => {
          msg.replyTo.send(reply)
          return { type: '_done' }
        },
        error => {
          msg.replyTo.send({ ok: false, error: String(error) })
          return { type: '_done' }
        },
      )
      return { state }
    },

    delete: (state, msg, ctx) => {
      ctx.pipeToSelf(
        (async () => {
          const found = await getWorkflow(workflowsDir, msg.userId, msg.workflowId)
          if (!found.ok || !('filepath' in found)) return found
          await unlink(found.filepath)
          return { ok: true as const, deleted: true as const, workflowId: msg.workflowId }
        })(),
        reply => {
          msg.replyTo.send(reply)
          return { type: '_done' }
        },
        error => {
          msg.replyTo.send({ ok: false, error: String(error) })
          return { type: '_done' }
        },
      )
      return { state }
    },
  }),
})
