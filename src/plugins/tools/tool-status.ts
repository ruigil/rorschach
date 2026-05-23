import type { ActorDef, ActorRef } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { JobRegistryTopic } from '../../types/tools.ts'
import { defineTool } from '../../system/index.ts'
import type { ToolMsg, ToolReply, ToolResultPayload } from '../../types/tools.ts'

// ─── Schema ───

export const toolStatusTool = defineTool('tool_status', 'Check the status of a long-running tool job by jobId, or list all currently active jobs when no jobId is supplied. Use this when the user asks whether a previously started background task is still running, has completed, or to enumerate in-flight jobs.', {
  type: 'object',
  properties: {
    jobId: {
      type: 'string',
      description: 'Optional. The jobId returned by an earlier long-running tool call. Omit to list all active jobs.',
    },
  },
})

// ─── State ───

type JobInfo = {
  toolName:  string
  toolRef:   ActorRef<ToolMsg>
  startedAt: number
  clientId?: string
  userId?:   string
  statusText?: string
  result?:   ToolResultPayload
  error?:    string
}

export type ToolStatusState = { jobs: Record<string, JobInfo> }


// ─── Internal message protocol ───

type InternalMsg =
  | { type: '_jobRegistered'; jobId: string; info: JobInfo }
  | { type: '_jobCleared';    jobId: string }
  | { type: '_jobCompleted';  jobId: string; result: ToolResultPayload }
  | { type: '_jobFailed';     jobId: string; error: string }

type ToolStatusMsg = ToolMsg | InternalMsg

// ─── Helpers ───

const formatAge = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

const formatJobStatus = (jobId: string, info: JobInfo): string => {
  const age = formatAge(Date.now() - info.startedAt)
  if (info.result !== undefined) {
    return `Job ${jobId} (${info.toolName}) completed (${age}): ${info.result.text}`
  }
  if (info.error !== undefined) {
    return `Job ${jobId} (${info.toolName}) failed: ${info.error}`
  }
  const detail = info.statusText ? ` ${info.statusText}` : ''
  return `Job ${jobId} (${info.toolName}) is still running, started ${age} ago.${detail}`
}

// ─── Actor ───

export const ToolStatus = (): ActorDef<ToolStatusMsg, ToolStatusState> => ({
  initialState: () => ({ jobs: {} }),
  lifecycle: onLifecycle({
    start: (state, ctx) => {
      ctx.subscribe(JobRegistryTopic, (event) => {
        if (event.status === 'cleared') {
          return { type: '_jobCleared' as const, jobId: event.jobId }
        }
        if (event.status === 'completed') {
          return { type: '_jobCompleted' as const, jobId: event.jobId, result: event.result }
        }
        if (event.status === 'failed') {
          return { type: '_jobFailed' as const, jobId: event.jobId, error: event.error }
        }
        return {
          type: '_jobRegistered' as const,
          jobId: event.jobId,
          info: {
            toolName:  event.toolName,
            toolRef:   event.toolRef,
            startedAt: event.startedAt,
            clientId:  event.clientId,
            userId:    event.userId,
            statusText: event.statusText,
          },
        }
      })
      return { state }
    },
  }),

  handler: onMessage<ToolStatusMsg, ToolStatusState>({
    _jobRegistered: (state, msg) => ({
      state: { jobs: { ...state.jobs, [msg.jobId]: msg.info } },
    }),

    _jobCompleted: (state, msg) => {
      const existing = state.jobs[msg.jobId]
      if (!existing) return { state }
      return { state: { jobs: { ...state.jobs, [msg.jobId]: { ...existing, result: msg.result } } } }
    },

    _jobFailed: (state, msg) => {
      const existing = state.jobs[msg.jobId]
      if (!existing) return { state }
      return { state: { jobs: { ...state.jobs, [msg.jobId]: { ...existing, error: msg.error } } } }
    },

    _jobCleared: (state, msg) => {
      const { [msg.jobId]: _drop, ...rest } = state.jobs
      return { state: { jobs: rest } }
    },

    invoke: (state, msg) => {
      let parsed: { jobId?: string }
      try {
        parsed = JSON.parse(msg.arguments) as { jobId?: string }
      } catch {
        parsed = {}
      }
      const jobId = parsed.jobId

      // No jobId → list all active jobs
      if (!jobId) {
        const entries = Object.entries(state.jobs)
        if (entries.length === 0) {
          msg.replyTo.send({ type: 'toolResult', result: { text: 'No active jobs.' } })
          return { state }
        }
        const lines = entries.map(([id, j]) => {
          const age = formatAge(Date.now() - j.startedAt)
      const detail = j.statusText ? `, ${j.statusText}` : ''
      const status = j.result !== undefined ? 'completed' : j.error !== undefined ? 'failed' : `running ${age}${detail}`
          return `- ${id} (${j.toolName}, ${status})`
        })
        msg.replyTo.send({ type: 'toolResult', result: { text: lines.join('\n') } })
        return { state }
      }

      const info = state.jobs[jobId]
      if (!info) {
        msg.replyTo.send({
          type: 'toolResult',
          result: { text: `No active job with id ${jobId}. It may have already completed.` },
        })
        return { state }
      }

      // Serve from cached state — no need to poll the underlying tool
      msg.replyTo.send({ type: 'toolResult', result: { text: formatJobStatus(jobId, info) } })
      return { state }
    },
  }),

  supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
})
