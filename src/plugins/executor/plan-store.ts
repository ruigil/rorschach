import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActorDef } from '../../system/types.ts'
import { onMessage } from '../../system/match.ts'
import type { Plan } from '../cognitive/types.ts'
import type { PlanGraph, PlanStoreMsg, PlanStoreReply, PlanSummary } from './types.ts'

const isPlan = (value: unknown): value is Plan => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj.id === 'string' &&
    typeof obj.goal === 'string' &&
    typeof obj.createdAt === 'string' &&
    Array.isArray(obj.tasks)
  )
}

const readPlanFile = async (filepath: string): Promise<Plan | null> => {
  try {
    const parsed = JSON.parse(await Bun.file(filepath).text()) as unknown
    return isPlan(parsed) ? parsed : null
  } catch {
    return null
  }
}

const listPlanFiles = async (plansDir: string): Promise<string[]> => {
  try {
    const entries = await readdir(plansDir, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => join(plansDir, entry.name))
  } catch {
    return []
  }
}

const summarize = (plan: Plan, filepath: string): PlanSummary => ({
  id:        plan.id,
  goal:      plan.goal,
  createdAt: plan.createdAt,
  taskCount: plan.tasks.length,
  filepath,
})

const toGraph = (plan: Plan): PlanGraph => {
  const dependents = new Map<string, string[]>()
  for (const task of plan.tasks) {
    for (const dep of task.dependencies) {
      const list = dependents.get(dep) ?? []
      list.push(task.id)
      dependents.set(dep, list)
    }
  }

  return {
    plan: {
      id:        plan.id,
      goal:      plan.goal,
      context:   plan.context,
      createdAt: plan.createdAt,
      taskCount: plan.tasks.length,
    },
    nodes: plan.tasks.map(task => ({
      id:                 task.id,
      label:              task.name,
      description:        task.description,
      validationCriteria: task.validationCriteria,
      dependencies:       task.dependencies,
      dependents:         dependents.get(task.id) ?? [],
      status:             'not_tracked',
    })),
    edges: plan.tasks.flatMap(task =>
      task.dependencies.map(dep => ({
        source: dep,
        target: task.id,
        type:   'depends_on' as const,
      })),
    ),
  }
}

const loadPlans = async (plansDir: string): Promise<Array<{ plan: Plan; filepath: string }>> => {
  const files = await listPlanFiles(plansDir)
  const loaded = await Promise.all(files.map(async filepath => ({ filepath, plan: await readPlanFile(filepath) })))
  return loaded
    .filter((entry): entry is { filepath: string; plan: Plan } => entry.plan !== null)
    .sort((a, b) => Date.parse(b.plan.createdAt) - Date.parse(a.plan.createdAt))
}

const getPlan = async (plansDir: string, planId: string): Promise<PlanStoreReply> => {
  const plans = await loadPlans(plansDir)
  const found = plans.find(entry => entry.plan.id === planId)
  if (!found) return { ok: false, error: `Plan not found: ${planId}`, status: 404 }
  return { ok: true, plan: found.plan, filepath: found.filepath }
}

export const PlanStore = (plansDir: string): ActorDef<PlanStoreMsg, null> => ({
  initialState: null,
  handler: onMessage<PlanStoreMsg, null>({
    _done: (state) => ({ state }),

    list: (state, msg, ctx) => {
      ctx.pipeToSelf(
        loadPlans(plansDir).then(plans => ({ ok: true as const, plans: plans.map(entry => summarize(entry.plan, entry.filepath)) })),
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
        getPlan(plansDir, msg.planId),
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
        getPlan(plansDir, msg.planId).then(reply => {
          if (!reply.ok || !('plan' in reply)) return reply
          return { ok: true as const, graph: toGraph(reply.plan) }
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
  }),
})
