import { mkdir } from 'node:fs/promises'
import { ask } from '../../system/index.ts'
import type { ActorDef, ActorRef } from '../../system/index.ts'
import { onMessage } from '../../system/index.ts'
import { OutboundMessageTopic } from '../../types/events.ts'
import { defineTool, parseToolArgs } from '../../system/index.ts'
import type { ToolReply } from '../../types/tools.ts'
import type { Plan, PlanTask, WorkflowToolsMsg, PlanStoreMsg, PlanStoreReply, PlanSummary } from './types.ts'

export const listPlansTool = defineTool('list_plans', 'List saved plans created by the planner.', {
  type: 'object',
  properties: {},
})

export const getPlanTool = defineTool('get_plan', 'Read a saved plan by id so you can answer detailed questions about its tasks and dependencies.', {
  type: 'object',
  required: ['planId'],
  properties: {
    planId: { type: 'string', description: 'The id of the plan to read.' },
  },
})

export const showPlanGraphTool = defineTool('show_plan_graph', 'Open the graphical DAG workspace for a saved plan by id.', {
  type: 'object',
  required: ['planId'],
  properties: {
    planId: { type: 'string', description: 'The id of the plan to show as a graph.' },
  },
})

export const savePlanTool = defineTool('save_plan', 'Finalize and save the accepted plan to disk. Call this only when the user has explicitly approved the plan you described conversationally.', {
  type: 'object',
  properties: {
    goal:    { type: 'string', description: 'The user-stated goal the plan addresses' },
    summary: { type: 'string', description: 'Brief narrative summary of the context gathered and key decisions made' },
    tasks: {
      type: 'array',
      description: 'Ordered list of tasks forming a DAG. Use "dependencies" to express ordering.',
      items: {
        type: 'object',
        properties: {
          id:                 { type: 'string', description: 'Short unique identifier' },
          name:               { type: 'string', description: 'Short task name' },
          description:        { type: 'string', description: 'What needs to be done' },
          validationCriteria: { type: 'string', description: 'How to verify this task is complete' },
          dependencies:       { type: 'array', items: { type: 'string' }, description: 'IDs of tasks that must complete before this one' },
        },
        required: ['id', 'name', 'description', 'validationCriteria', 'dependencies'],
      },
    },
  },
  required: ['goal', 'summary', 'tasks'],
})

export const updatePlanTool = defineTool('update_plan', 'Update an existing saved plan. You can modify the goal, context/summary, and tasks. Only the fields you provide will be updated; omitted fields remain unchanged.', {
  type: 'object',
  required: ['planId'],
  properties: {
    planId:  { type: 'string', description: 'The id of the plan to update.' },
    goal:    { type: 'string', description: 'The updated goal for the plan.' },
    summary: { type: 'string', description: 'Updated narrative summary of context and decisions.' },
    tasks: {
      type: 'array',
      description: 'Updated ordered list of tasks forming a DAG.',
      items: {
        type: 'object',
        properties: {
          id:                 { type: 'string', description: 'Short unique identifier' },
          name:               { type: 'string', description: 'Short task name' },
          description:        { type: 'string', description: 'What needs to be done' },
          validationCriteria: { type: 'string', description: 'How to verify this task is complete' },
          dependencies:       { type: 'array', items: { type: 'string' }, description: 'IDs of tasks that must complete before this one' },
        },
        required: ['id', 'name', 'description', 'validationCriteria', 'dependencies'],
      },
    },
  },
})

export const deletePlanTool = defineTool('delete_plan', 'Delete a saved plan by id. This permanently removes the plan file from disk.', {
  type: 'object',
  required: ['planId'],
  properties: {
    planId: { type: 'string', description: 'The id of the plan to delete.' },
  },
})

const formatPlanList = (plans: PlanSummary[]): string => {
  if (plans.length === 0) return 'No saved plans found.'
  return plans.map(plan => {
    const date = plan.createdAt.slice(0, 10)
    return `- ${plan.goal} (id: ${plan.id}, created: ${date}, tasks: ${plan.taskCount})`
  }).join('\n')
}

const planIdArg = (raw: string): { ok: true; planId: string } | { ok: false; error: string } => {
  const parsed = parseToolArgs(raw, obj => {
    const planId = obj.planId
    return typeof planId === 'string' && planId.trim() ? { planId: planId.trim() } : null
  }, 'Missing required argument: planId')
  return parsed.ok ? { ok: true, planId: parsed.value.planId } : parsed
}

const replyError = (replyTo: ActorRef<ToolReply>, error: string): void => {
  replyTo.send({ type: 'toolError', error })
}

const todayISO = (): string => new Date().toISOString().slice(0, 10)

const slugify = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)

export const WorkflowTools = (
  planStoreRef: ActorRef<PlanStoreMsg>,
  plansDir: string,
): ActorDef<WorkflowToolsMsg, null> => ({
  initialState: null,
  handler: onMessage<WorkflowToolsMsg, null>({
    _done: (state) => ({ state }),

    invoke: (state, msg, ctx) => {
      if (msg.toolName === listPlansTool.name) {
        ctx.pipeToSelf(
          ask<PlanStoreMsg, PlanStoreReply>(planStoreRef, replyTo => ({ type: 'list', replyTo }), { timeoutMs: 5_000 }),
          reply => {
            if (!reply.ok) replyError(msg.replyTo, reply.error)
            else if ('plans' in reply) msg.replyTo.send({ type: 'toolResult', result: { text: formatPlanList(reply.plans) } })
            else replyError(msg.replyTo, 'Unexpected plan store response.')
            return { type: '_done' }
          },
          error => {
            replyError(msg.replyTo, String(error))
            return { type: '_done' }
          },
        )
        return { state }
      }

      if (msg.toolName === getPlanTool.name) {
        const arg = planIdArg(msg.arguments)
        if (!arg.ok) {
          replyError(msg.replyTo, arg.error)
          return { state }
        }
        ctx.pipeToSelf(
          ask<PlanStoreMsg, PlanStoreReply>(planStoreRef, replyTo => ({ type: 'get', planId: arg.planId, replyTo }), { timeoutMs: 5_000 }),
          reply => {
            if (!reply.ok) replyError(msg.replyTo, reply.error)
            else if ('plan' in reply) msg.replyTo.send({ type: 'toolResult', result: { text: JSON.stringify(reply.plan, null, 2) } })
            else replyError(msg.replyTo, 'Unexpected plan store response.')
            return { type: '_done' }
          },
          error => {
            replyError(msg.replyTo, String(error))
            return { type: '_done' }
          },
        )
        return { state }
      }

      if (msg.toolName === showPlanGraphTool.name) {
        const arg = planIdArg(msg.arguments)
        if (!arg.ok) {
          replyError(msg.replyTo, arg.error)
          return { state }
        }
        ctx.pipeToSelf(
          ask<PlanStoreMsg, PlanStoreReply>(planStoreRef, replyTo => ({ type: 'graph', planId: arg.planId, replyTo }), { timeoutMs: 5_000 }),
          reply => {
            if (!reply.ok) {
              replyError(msg.replyTo, reply.error)
            } else if ('graph' in reply) {
              if (msg.clientId) {
                ctx.publish(OutboundMessageTopic, {
                  clientId: msg.clientId,
                  text:     JSON.stringify({ type: 'planGraph', planId: arg.planId }),
                })
              }
              msg.replyTo.send({
                type:   'toolResult',
                result: { text: `Opened graph for "${reply.graph.plan.goal}" (${reply.graph.nodes.length} tasks).` },
              })
            } else {
              replyError(msg.replyTo, 'Unexpected plan store response.')
            }
            return { type: '_done' }
          },
          error => {
            replyError(msg.replyTo, String(error))
            return { type: '_done' }
          },
        )
        return { state }
      }

      if (msg.toolName === savePlanTool.name) {
        const parent = ctx.trace.fromHeaders()
        const span = parent
          ? ctx.trace.child(parent.traceId, parent.spanId, savePlanTool.name, { toolName: savePlanTool.name })
          : null

        let goal:    string
        let summary: string
        let tasks:   PlanTask[]
        try {
          const args = JSON.parse(msg.arguments) as { goal?: string; summary?: string; tasks?: PlanTask[] }
          goal    = args.goal    ?? ''
          summary = args.summary ?? ''
          tasks   = args.tasks   ?? []
          if (!goal) throw new Error('missing goal')
        } catch (err) {
          const error = `invalid arguments: ${String(err)}`
          span?.error(error)
          replyError(msg.replyTo, error)
          return { state }
        }

        const plan: Plan = {
          id:        crypto.randomUUID(),
          goal,
          context:   summary,
          createdAt: new Date().toISOString(),
          tasks,
        }

        const shortId  = crypto.randomUUID().slice(0, 8)
        const filename = `${todayISO()}-${slugify(goal)}-${shortId}.json`
        const filepath = `${plansDir}/${filename}`

        ctx.log.info('workflow-tools: writing plan', { filepath, tasks: plan.tasks.length })

        ctx.pipeToSelf(
          (async () => {
            await mkdir(plansDir, { recursive: true })
            await Bun.write(filepath, JSON.stringify(plan, null, 2))
          })(),
          ()    => ({ type: '_writeDone' as const, filepath, taskCount: plan.tasks.length, planId: plan.id, clientId: msg.clientId, replyTo: msg.replyTo, span }),
          (err) => ({ type: '_writeErr'  as const, error: String(err),                    replyTo: msg.replyTo, span }),
        )

        return { state }
      }

      if (msg.toolName === updatePlanTool.name) {
        let planId: string
        let patch: { goal?: string; context?: string; tasks?: PlanTask[] }
        try {
          const args = JSON.parse(msg.arguments) as { planId?: string; goal?: string; summary?: string; tasks?: PlanTask[] }
          if (!args.planId || typeof args.planId !== 'string') throw new Error('missing planId')
          planId = args.planId.trim()
          patch = {
            ...(args.goal    !== undefined && { goal: args.goal }),
            ...(args.summary !== undefined && { context: args.summary }),
            ...(args.tasks   !== undefined && { tasks: args.tasks }),
          }
          if (Object.keys(patch).length === 0) throw new Error('provide at least one field to update (goal, summary, or tasks)')
        } catch (err) {
          replyError(msg.replyTo, `invalid arguments: ${String(err)}`)
          return { state }
        }

        ctx.log.info('workflow-tools: updating plan', { planId })
        ctx.pipeToSelf(
          ask<PlanStoreMsg, PlanStoreReply>(planStoreRef, replyTo => ({ type: 'update', planId, patch, replyTo }), { timeoutMs: 5_000 }),
          reply => {
            if (!reply.ok) replyError(msg.replyTo, reply.error)
            else if ('updated' in reply) {
              msg.replyTo.send({ type: 'toolResult', result: { text: `Plan ${planId} updated successfully (${reply.plan.tasks.length} tasks).` } })
              if (msg.clientId) {
                ctx.publish(OutboundMessageTopic, {
                  clientId: msg.clientId,
                  text: JSON.stringify({ type: 'planGraph', planId }),
                })
              }
            }
            else replyError(msg.replyTo, 'Unexpected plan store response.')
            return { type: '_done' }
          },
          error => {
            replyError(msg.replyTo, String(error))
            return { type: '_done' }
          },
        )
        return { state }
      }

      if (msg.toolName === deletePlanTool.name) {
        const arg = planIdArg(msg.arguments)
        if (!arg.ok) {
          replyError(msg.replyTo, arg.error)
          return { state }
        }

        ctx.log.info('workflow-tools: deleting plan', { planId: arg.planId })
        ctx.pipeToSelf(
          ask<PlanStoreMsg, PlanStoreReply>(planStoreRef, replyTo => ({ type: 'delete', planId: arg.planId, replyTo }), { timeoutMs: 5_000 }),
          reply => {
            if (!reply.ok) replyError(msg.replyTo, reply.error)
            else if ('deleted' in reply) {
              msg.replyTo.send({ type: 'toolResult', result: { text: `Plan ${arg.planId} deleted.` } })
              if (msg.clientId) {
                ctx.publish(OutboundMessageTopic, {
                  clientId: msg.clientId,
                  text: JSON.stringify({ type: 'planGraph' }),
                })
              }
            }
            else replyError(msg.replyTo, 'Unexpected plan store response.')
            return { type: '_done' }
          },
          error => {
            replyError(msg.replyTo, String(error))
            return { type: '_done' }
          },
        )
        return { state }
      }

      replyError(msg.replyTo, `Unknown tool: ${msg.toolName}`)
      return { state }
    },

    _writeDone: (state, msg, ctx) => {
      const { filepath, taskCount, planId, clientId, replyTo, span } = msg
      span?.done({ filepath, taskCount })
      replyTo.send({
        type: 'toolResult',
        result: { text: `Plan saved to ${filepath} — ${taskCount} tasks.` },
      })
      if (clientId) {
        ctx.publish(OutboundMessageTopic, {
          clientId,
          text: JSON.stringify({ type: 'planGraph', planId }),
        })
      }
      return { state }
    },

    _writeErr: (state, msg, ctx) => {
      const { error, replyTo, span } = msg
      ctx.log.error('workflow-tools: write failed', { error })
      span?.error(error)
      replyTo.send({ type: 'toolError', error })
      return { state }
    },
  }),
})
