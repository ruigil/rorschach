import { CronExpressionParser } from 'cron-parser'
import type { ActorContext, ActorDef, ActorRef } from '../../system/index.ts'
import { persistencePluginAdapter } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { defineTool } from '../../system/index.ts'
import { JobRegistryTopic, type ToolInvokeMsg, type ToolMsg } from '../../types/tools.ts'
import type { CronState, CronJob } from './types.ts'

// ─── Tool names & schemas ───

export const cronCreateTool = defineTool('cron_create', 'Schedule a prompt to be delivered later on a cron schedule. Returns toolPending until the next fire; that completion injects the prompt.', {
  type: 'object',
  properties: {
    expression: { type: 'string', description: 'Standard 5-field cron expression (e.g. "0 9 * * 1-5" for weekdays at 9am).' },
    prompt:     { type: 'string', description: 'The prompt delivered when the schedule fires.' },
    run_once:   { type: 'boolean', description: 'If true, the schedule is deleted after firing once. Defaults to false.' },
    timezone:   { type: 'string', description: 'IANA timezone name (e.g. "America/New_York", "Europe/Paris").' },
  },
  required: ['expression', 'prompt'],
})

export const cronDeleteTool = defineTool('cron_delete', 'Delete a scheduled cron job by schedule ID (from cron_list or the create acknowledgment).', {
  type: 'object',
  properties: {
    jobId: { type: 'string', description: 'The schedule ID.' },
  },
  required: ['jobId'],
})

export const cronListTool = defineTool('cron_list', 'List all scheduled cron jobs with their IDs, expressions, prompts, and next scheduled run time.', {
  type: 'object',
  properties: {},
})

type CronMsg =
  | ToolInvokeMsg
  | { type: '_tick'; jobId: string }


// ─── Persistence ───

const persistence = persistencePluginAdapter<CronState>('tools/cron-jobs')

// ─── Helpers ───

// setTimeout uses a 32-bit signed integer — cap at ~24.8 days to avoid overflow.
const MAX_TIMER_MS = 2_147_483_647

const nextFireAt = (expression: string, tz?: string): number =>
  CronExpressionParser.parse(expression, tz ? { tz } : undefined).next().toDate().getTime()

const formatLocalDate = (epochMs: number, tz?: string): string => {
  const d = new Date(epochMs)
  if (tz) {
    try {
      const year = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' }).format(d)
      const month = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: '2-digit' }).format(d)
      const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, day: '2-digit' }).format(d)
      const hour = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(d)
      const minute = new Intl.DateTimeFormat('en-US', { timeZone: tz, minute: '2-digit' }).format(d)
      const second = new Intl.DateTimeFormat('en-US', { timeZone: tz, second: '2-digit' }).format(d)

      let cleanHour = hour.trim()
      if (cleanHour === '24') cleanHour = '00'
      else if (cleanHour.length === 1) cleanHour = `0${cleanHour}`

      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(d)
      const tzPart = parts.find(p => p.type === 'timeZoneName')?.value
      let offset = 'Z'
      if (tzPart) {
        const match = tzPart.match(/GMT([+-]\d{1,2}):?(\d{2})?/)
        if (match) {
          const sign = match[1]!.startsWith('+') ? '+' : '-'
          const hours = Math.abs(parseInt(match[1]!, 10)).toString().padStart(2, '0')
          const mins = match[2] || '00'
          offset = `${sign}${hours}:${mins}`
        } else if (tzPart === 'GMT') {
          offset = '+00:00'
        }
      }
      return `${year}-${month}-${day}T${cleanHour}:${minute}:${second}${offset === 'Z' ? '+00:00' : offset}`
    } catch {}
  }
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

/** Arm the schedule on the job bus (create / re-arm / restore). Not used at fire time. */
const publishArmed = (job: CronJob, ctx: ActorContext<ToolMsg>) => {
  ctx.publishRetained(JobRegistryTopic, job.id, {
    jobId: job.id,
    status: 'running',
    toolName: cronCreateTool.name,
    toolRef: ctx.self as unknown as ActorRef<ToolMsg>,
    startedAt: Date.now(),
    userId: job.userId,
    statusText: `Next run: ${formatLocalDate(job.nextFireAt, job.timezone)}`,
  })
}

// ─── Actor ───

export const Cron = (): ActorDef<CronMsg, CronState> => ({
  initialState: () => ({ jobs: {} }),
  persistence,

  lifecycle: onLifecycle({
    start: (state, ctx) => {
      for (const job of Object.values(state.jobs)) {
        publishArmed(job, ctx)
        scheduleTimer(job, ctx)
      }

      ctx.log.info(`cron actor started with ${Object.keys(state.jobs).length} job(s)`)
      return { state }
    },
  }),

  handler: onMessage<CronMsg, CronState>({
    invoke: (state, msg, ctx) => {
      const { toolName, arguments: rawArgs, replyTo } = msg

      if (toolName === cronCreateTool.name) {
        let args: { expression: string; prompt: string; run_once?: boolean; timezone?: string }
        try { args = JSON.parse(rawArgs) } catch {
          replyTo.send({ type: 'toolError', error: 'Invalid JSON arguments' })
          return { state }
        }

        const jobTz = args.timezone ?? undefined
        try { CronExpressionParser.parse(args.expression, jobTz ? { tz: jobTz } : undefined) } catch (e) {
          replyTo.send({ type: 'toolError', error: `Invalid cron expression: ${String(e)}` })
          return { state }
        }

        const id = crypto.randomUUID()
        const fireAt = nextFireAt(args.expression, jobTz)
        const job: CronJob = {
          id,
          expression: args.expression,
          prompt: args.prompt,
          runOnce: args.run_once ?? false,
          createdAt: Date.now(),
          lastFiredAt: null,
          nextFireAt: fireAt,
          userId: msg.userId,
          timezone: jobTz,
        }

        scheduleTimer(job, ctx)
        // running is published by invokeTool when it sees toolPending (schedule time).
        ctx.log.info('cron job created', { id, expression: args.expression, nextIn: `${Math.round((fireAt - Date.now()) / 1000)}s` })

        replyTo.send({
          type: 'toolPending',
          jobId: id,
          placeholderText: `Scheduled. Schedule id: ${id}. Next run: ${formatLocalDate(fireAt, jobTz)}.`,
        })
        return { state: { ...state, jobs: { ...state.jobs, [id]: job } } }
      }

      if (toolName === cronDeleteTool.name) {
        let args: { jobId: string }
        try { args = JSON.parse(rawArgs) } catch {
          replyTo.send({ type: 'toolError', error: 'Invalid JSON arguments' })
          return { state }
        }

        const job = state.jobs[args.jobId]
        if (!job) {
          replyTo.send({ type: 'toolError', error: `Job ${args.jobId} not found` })
          return { state }
        }

        ctx.timers.cancel(job.id)
        ctx.publishRetained(JobRegistryTopic, job.id, {
          jobId: job.id,
          status: 'cleared',
        })
        const { [job.id]: _removed, ...remaining } = state.jobs
        ctx.log.info('cron job deleted', { id: job.id })

        replyTo.send({ type: 'toolResult', result: { text: `Deleted cron job ${job.id}` } })
        return { state: { ...state, jobs: remaining } }
      }

      if (toolName === cronListTool.name) {
        const jobs = Object.values(state.jobs)
        if (jobs.length === 0) {
          replyTo.send({ type: 'toolResult', result: { text: 'No scheduled cron jobs.' } })
          return { state }
        }

        const lines = jobs.map(j => {
          const preview = j.prompt.length > 60 ? `${j.prompt.slice(0, 60)}…` : j.prompt
          const lastFired = j.lastFiredAt ? formatLocalDate(j.lastFiredAt, j.timezone) : 'never'
          return `- ${j.id}: "${j.expression}" → ${preview}\n  Next: ${formatLocalDate(j.nextFireAt, j.timezone)}  Last fired: ${lastFired}`
        })
        replyTo.send({ type: 'toolResult', result: { text: lines.join('\n') } })
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

      // job fired
      ctx.log.info('cron job fired', { id: job.id, expression: job.expression, userId: job.userId })
      ctx.publishRetained(JobRegistryTopic, job.id, {
        jobId: job.id,
        status: 'completed',
        result: { text: job.prompt },
      })

      if (job.runOnce) {
        ctx.log.info('cron job completed (run_once)', { id: job.id })
        ctx.publishRetained(JobRegistryTopic, job.id, { jobId: job.id, status: 'cleared' })
        const { [job.id]: _removed, ...remaining } = state.jobs
        return { state: { ...state, jobs: remaining } }
      }

      const fireAt = nextFireAt(job.expression, job.timezone)
      const updatedJob: CronJob = {
        ...job,
        lastFiredAt: Date.now(),
        nextFireAt: fireAt,
      }
      // Re-arm same id for the next window (schedule time, not fire time).
      publishArmed(updatedJob, ctx)
      scheduleTimer(updatedJob, ctx)

      return {
        state: { ...state, jobs: { ...state.jobs, [job.id]: updatedJob } },
      }
    },

  }),

  supervision: { type: 'restart', maxRetries: 3, withinMs: 60_000 },
})
