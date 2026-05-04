import type { ActorDef } from '../../system/types.ts'
import { onMessage } from '../../system/match.ts'
import type { ToolMsg, ToolSchema } from '../../types/tools.ts'

// ─── Schema ───

export const LONG_TASK_TOOL_NAME = 'long_task'

export const LONG_TASK_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: LONG_TASK_TOOL_NAME,
    description:
      'Demonstration long-running tool. Returns a job id immediately and "completes" after delaySeconds, ' +
      'returning the supplied message as the result. Useful for testing background-completion flows.',
    parameters: {
      type: 'object',
      properties: {
        delaySeconds: { type: 'integer', description: 'How long to simulate working, in seconds.' },
        message:      { type: 'string',  description: 'Result text to deliver when the task completes.' },
      },
      required: ['delaySeconds', 'message'],
    },
  },
}

// ─── State ───

type JobStatus = 'running' | 'done' | 'error'
type Job = { jobId: string; status: JobStatus; result?: string; error?: string }
export type LongTaskState = { jobs: Record<string, Job> }

export const createInitialLongTaskState = (): LongTaskState => ({ jobs: {} })

// ─── Internal message protocol ───

type InternalMsg =
  | { type: '_complete'; jobId: string }
  | { type: '_fail';     jobId: string; error: string }

type Msg = ToolMsg | InternalMsg

// ─── Actor ───

export const createLongTaskActor = (): ActorDef<Msg, LongTaskState> => ({
  handler: onMessage<Msg, LongTaskState>({
    invoke: (state, msg, ctx) => {
      const { arguments: rawArgs, replyTo } = msg
      let parsed: { delaySeconds: number; message: string }
      try {
        parsed = JSON.parse(rawArgs) as { delaySeconds: number; message: string }
      } catch (err) {
        replyTo.send({ type: 'toolError', error: `Invalid arguments: ${String(err)}` })
        return { state }
      }
      const { delaySeconds, message } = parsed
      if (typeof delaySeconds !== 'number' || delaySeconds < 0) {
        replyTo.send({ type: 'toolError', error: 'delaySeconds must be a non-negative number' })
        return { state }
      }

      const jobId = crypto.randomUUID()
      ctx.timers.startSingleTimer(`long_task:${jobId}`, { type: '_complete', jobId }, delaySeconds * 1000)
      replyTo.send({
        type: 'toolPending',
        jobId,
        placeholderText: `Started long task ${jobId} (delay=${delaySeconds}s).`,
        pollIntervalMs: 2000,
      })
      return { state: { jobs: { ...state.jobs, [jobId]: { jobId, status: 'running', result: message } } } }
    },

    jobStatus: (state, msg) => {
      const job = state.jobs[msg.jobId]
      if (!job) {
        msg.replyTo.send({ type: 'toolError', error: `Unknown jobId ${msg.jobId}` })
        return { state }
      }
      if (job.status === 'running') {
        msg.replyTo.send({ type: 'toolPending', jobId: msg.jobId })
        return { state }
      }
      if (job.status === 'done') {
        msg.replyTo.send({ type: 'toolResult', result: job.result ?? '' })
      } else {
        msg.replyTo.send({ type: 'toolError', error: job.error ?? 'unknown error' })
      }
      const { [msg.jobId]: _drop, ...rest } = state.jobs
      return { state: { jobs: rest } }
    },

    _complete: (state, msg) => {
      const job = state.jobs[msg.jobId]
      if (!job) return { state }
      return { state: { jobs: { ...state.jobs, [msg.jobId]: { ...job, status: 'done' } } } }
    },

    _fail: (state, msg) => {
      const job = state.jobs[msg.jobId]
      if (!job) return { state }
      return { state: { jobs: { ...state.jobs, [msg.jobId]: { ...job, status: 'error', error: msg.error } } } }
    },
  }),

  supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
})
