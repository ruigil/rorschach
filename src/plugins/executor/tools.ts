import { ask } from '../../system/ask.ts'
import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onMessage } from '../../system/match.ts'
import { OutboundMessageTopic } from '../../types/events.ts'
import { defineTool, parseToolArgs } from '../../types/tools.ts'
import type { ToolReply } from '../../types/tools.ts'
import type { ExecutorToolsMsg, PlanStoreMsg, PlanStoreReply, PlanSummary } from './types.ts'

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

export const ExecutorTools = (
  planStoreRef: ActorRef<PlanStoreMsg>,
): ActorDef<ExecutorToolsMsg, null> => ({
  initialState: null,
  handler: onMessage<ExecutorToolsMsg, null>({
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

      replyError(msg.replyTo, `Unknown tool: ${msg.toolName}`)
      return { state }
    },
  }),
})
