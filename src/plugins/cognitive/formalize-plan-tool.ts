import { mkdir } from 'node:fs/promises'
import type { ActorDef, ActorRef, SpanHandle } from '../../system/types.ts'
import { onMessage } from '../../system/match.ts'
import { defineTool } from '../../types/tools.ts'
import type { ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import type { Plan, PlanTask } from './types.ts'

// ─── Schema ───

export const formalizePlanTool = defineTool('formalize_plan', 'Finalize and save the accepted plan to disk. Call this only when the user has explicitly approved the plan you described conversationally.', {
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

// ─── Internal message protocol ───

export type FormalizePlanToolMsg =
  | ToolInvokeMsg
  | { type: '_writeDone'; filepath: string; taskCount: number; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_writeErr';  error: string;    replyTo: ActorRef<ToolReply>; span: SpanHandle | null }

// ─── Helpers ───

const todayISO = (): string => new Date().toISOString().slice(0, 10)

const slugify = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)

// ─── Actor ───

export const FormalizePlanTool = (
  opts: { plansDir: string },
): ActorDef<FormalizePlanToolMsg, null> => {
  const { plansDir } = opts

  return {
    initialState: null,
    handler: onMessage<FormalizePlanToolMsg, null>({
      invoke: (state, message, ctx) => {
        const { arguments: rawArgs, replyTo } = message

        const parent = ctx.trace.fromHeaders()
        const span: SpanHandle | null = parent
          ? ctx.trace.child(parent.traceId, parent.spanId, formalizePlanTool.name, { toolName: formalizePlanTool.name })
          : null

        let goal:    string
        let summary: string
        let tasks:   PlanTask[]
        try {
          const args = JSON.parse(rawArgs) as { goal?: string; summary?: string; tasks?: PlanTask[] }
          goal    = args.goal    ?? ''
          summary = args.summary ?? ''
          tasks   = args.tasks   ?? []
          if (!goal) throw new Error('missing goal')
        } catch (err) {
          const error = `invalid arguments: ${String(err)}`
          span?.error(error)
          replyTo.send({ type: 'toolError', error })
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

        ctx.log.info('formalize-plan-tool: writing plan', { filepath, tasks: plan.tasks.length })

        ctx.pipeToSelf(
          (async () => {
            await mkdir(plansDir, { recursive: true })
            await Bun.write(filepath, JSON.stringify(plan, null, 2))
          })(),
          ()    => ({ type: '_writeDone' as const, filepath, taskCount: plan.tasks.length, replyTo, span }),
          (err) => ({ type: '_writeErr'  as const, error: String(err),                    replyTo, span }),
        )

        return { state }
      },

      _writeDone: (state, message) => {
        const { filepath, taskCount, replyTo, span } = message
        span?.done({ filepath, taskCount })
        replyTo.send({
          type: 'toolResult',
          result: { text: `Plan saved to ${filepath} — ${taskCount} tasks.` },
        })
        return { state }
      },

      _writeErr: (state, message, ctx) => {
        const { error, replyTo, span } = message
        ctx.log.error('formalize-plan-tool: write failed', { error })
        span?.error(error)
        replyTo.send({ type: 'toolError', error })
        return { state }
      },
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
