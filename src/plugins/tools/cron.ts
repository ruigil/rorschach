import { CronExpressionParser } from 'cron-parser'
import type { ActorDef, PersistenceAdapter } from '../../system/types.ts'
import { emit } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import type { ToolInvokeMsg, ToolSchema } from '../../types/tools.ts'
import { CronTriggerTopic } from '../../types/events.ts'

// ─── Tool names & schemas ───

export const CRON_CREATE_TOOL_NAME = 'cron_create'
export const CRON_DELETE_TOOL_NAME = 'cron_delete'
export const CRON_LIST_TOOL_NAME   = 'cron_list'

export const CRON_CREATE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: CRON_CREATE_TOOL_NAME,
    description: 'Schedule a prompt to be sent on a recurring cron schedule. Returns the job ID.',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Standard 5-field cron expression (e.g. "0 9 * * 1-5" for weekdays at 9am).' },
        prompt:     { type: 'string', description: 'The prompt to send when the schedule fires.' },
        run_once:   { type: 'boolean', description: 'If true, the job is deleted after firing once. Defaults to false.' },
      },
      required: ['expression', 'prompt'],
    },
  },
}

export const CRON_DELETE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: CRON_DELETE_TOOL_NAME,
    description: 'Delete a scheduled cron job by ID.',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The job ID returned by cron_create.' },
      },
      required: ['jobId'],
    },
  },
}

export const CRON_LIST_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: CRON_LIST_TOOL_NAME,
    description: 'List all scheduled cron jobs with their IDs, expressions, prompts, and next scheduled run time.',
    parameters: { type: 'object', properties: {} },
  },
}

// ─── Types ───

type CronJob = {
  id: string
  expression: string
  prompt: string
  runOnce: boolean
  createdAt: number
  lastFiredAt: number | null
  nextFireAt: number  // epoch ms — used to detect early wakeups from 32-bit timer cap
  userId: string
}

export type CronState = {
  jobs: Record<string, CronJob>
}

type CronMsg =
  | ToolInvokeMsg
  | { type: '_tick'; jobId: string }

// ─── Persistence ───

const PERSIST_PATH = 'workspace/cron-jobs.json'

const persistence: PersistenceAdapter<CronState> = {
  load: async () => {
    const file = Bun.file(PERSIST_PATH)
    if (!await file.exists()) return undefined
    const data = JSON.parse(await file.text()) as { jobs: Record<string, CronJob> }
    return { jobs: data.jobs ?? {} }
  },
  save: async (state) => {
    await Bun.write(PERSIST_PATH, JSON.stringify({ jobs: state.jobs }, null, 2))
  },
}

// ─── Helpers ───

// setTimeout uses a 32-bit signed integer — cap at ~24.8 days to avoid overflow.
const MAX_TIMER_MS = 2_147_483_647

const nextFireAt = (expression: string): number =>
  CronExpressionParser.parse(expression).next().toDate().getTime()

const formatLocalDate = (epochMs: number): string => {
  const d = new Date(epochMs)
  const offset = -d.getTimezoneOffset()
  const sign  = offset >= 0 ? '+' : '-'
  const hh    = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')
  const mm    = String(Math.abs(offset) % 60).padStart(2, '0')
  const local = new Date(epochMs - d.getTimezoneOffset() * 60_000)
  return `${local.toISOString().slice(0, 19)}${sign}${hh}:${mm}`
}

const scheduleTimer = (job: CronJob, ctx: { timers: { startSingleTimer: (key: string, msg: CronMsg, delayMs: number) => void } }) => {
  const delayMs = Math.max(0, Math.min(job.nextFireAt - Date.now(), MAX_TIMER_MS))
  ctx.timers.startSingleTimer(job.id, { type: '_tick', jobId: job.id }, delayMs)
}

// ─── Actor ───

export const createCronActor = (): ActorDef<CronMsg, CronState> => ({
  persistence,

  lifecycle: onLifecycle({
    start: (state, ctx) => {
      for (const job of Object.values(state.jobs)) {
        scheduleTimer(job, ctx)
      }

      ctx.log.info(`cron actor started with ${Object.keys(state.jobs).length} job(s)`)
      return { state }
    },
  }),

  handler: onMessage<CronMsg, CronState>({
    invoke: (state, msg, ctx) => {
      const { toolName, arguments: rawArgs, replyTo } = msg

      if (toolName === CRON_CREATE_TOOL_NAME) {
        let args: { expression: string; prompt: string; run_once?: boolean }
        try { args = JSON.parse(rawArgs) } catch {
          replyTo.send({ type: 'toolError', error: 'Invalid JSON arguments' })
          return { state }
        }

        try { CronExpressionParser.parse(args.expression) } catch (e) {
          replyTo.send({ type: 'toolError', error: `Invalid cron expression: ${String(e)}` })
          return { state }
        }

        const id = crypto.randomUUID()
        const fireAt = nextFireAt(args.expression)
        const job: CronJob = { id, expression: args.expression, prompt: args.prompt, runOnce: args.run_once ?? false, createdAt: Date.now(), lastFiredAt: null, nextFireAt: fireAt, userId: msg.userId }

        scheduleTimer(job, ctx)
        ctx.log.info('cron job created', { id, expression: args.expression, nextIn: `${Math.round((fireAt - Date.now()) / 1000)}s` })

        replyTo.send({ type: 'toolResult', result: `Created cron job ${id}. Next run: ${formatLocalDate(fireAt)}` })
        return { state: { ...state, jobs: { ...state.jobs, [id]: job } } }
      }

      if (toolName === CRON_DELETE_TOOL_NAME) {
        let args: { jobId: string }
        try { args = JSON.parse(rawArgs) } catch {
          replyTo.send({ type: 'toolError', error: 'Invalid JSON arguments' })
          return { state }
        }

        if (!state.jobs[args.jobId]) {
          replyTo.send({ type: 'toolError', error: `Job ${args.jobId} not found` })
          return { state }
        }

        ctx.timers.cancel(args.jobId)
        const { [args.jobId]: _removed, ...remaining } = state.jobs
        ctx.log.info('cron job deleted', { id: args.jobId })

        replyTo.send({ type: 'toolResult', result: `Deleted cron job ${args.jobId}` })
        return { state: { ...state, jobs: remaining } }
      }

      if (toolName === CRON_LIST_TOOL_NAME) {
        const jobs = Object.values(state.jobs)
        if (jobs.length === 0) {
          replyTo.send({ type: 'toolResult', result: 'No scheduled cron jobs.' })
          return { state }
        }

        const lines = jobs.map(j => {
          const preview = j.prompt.length > 60 ? `${j.prompt.slice(0, 60)}…` : j.prompt
          const lastFired = j.lastFiredAt ? formatLocalDate(j.lastFiredAt) : 'never'
          return `- ${j.id}: "${j.expression}" → ${preview}\n  Next: ${formatLocalDate(j.nextFireAt)}  Last fired: ${lastFired}`
        })
        replyTo.send({ type: 'toolResult', result: lines.join('\n') })
        return { state }
      }

      replyTo.send({ type: 'toolError', error: `Unknown tool: ${toolName}` })
      return { state }
    },

    _tick: (state, msg, ctx) => {
      const job = state.jobs[msg.jobId]
      if (!job) return { state }  // deleted before tick fired

      // Timer may have woken up early due to 32-bit cap — reschedule and wait
      if (Date.now() < job.nextFireAt - 1_000) {
        scheduleTimer(job, ctx)
        return { state }
      }

      ctx.log.info('cron job fired', { id: job.id, expression: job.expression, userId: job.userId })

      const span = ctx.trace.start('cron', { userId: job.userId, jobId: job.id })
      const events = [emit(CronTriggerTopic, {
        userId:      job.userId,
        text:        job.prompt,
        traceId:     span.traceId,
        parentSpanId: span.spanId,
      })]

      if (job.runOnce) {
        ctx.log.info('cron job completed (run_once)', { id: job.id })
        const { [job.id]: _removed, ...remaining } = state.jobs
        return { state: { ...state, jobs: remaining }, events }
      }

      const fireAt = nextFireAt(job.expression)
      const updatedJob = { ...job, lastFiredAt: Date.now(), nextFireAt: fireAt }
      scheduleTimer(updatedJob, ctx)

      return {
        state: { ...state, jobs: { ...state.jobs, [job.id]: updatedJob } },
        events,
      }
    },

  }),

  supervision: { type: 'restart', maxRetries: 3, withinMs: 60_000 },
})
