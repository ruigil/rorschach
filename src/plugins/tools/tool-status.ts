import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { ask } from '../../system/ask.ts'
import { JobRegistryTopic } from '../../types/tools.ts'
import type { ToolMsg, ToolReply, ToolSchema } from '../../types/tools.ts'

// ─── Schema ───

export const TOOL_STATUS_TOOL_NAME = 'tool_status'

export const TOOL_STATUS_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: TOOL_STATUS_TOOL_NAME,
    description:
      'Check the status of a long-running tool job by jobId, or list all currently active jobs ' +
      'when no jobId is supplied. Use this when the user asks whether a previously started ' +
      'background task is still running, has completed, or to enumerate in-flight jobs.',
    parameters: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'Optional. The jobId returned by an earlier long-running tool call. Omit to list all active jobs.',
        },
      },
    },
  },
}

// ─── State ───

type JobInfo = {
  toolName:  string
  toolRef:   ActorRef<ToolMsg>
  startedAt: number
  clientId?: string
  userId?:   string
}

export type ToolStatusState = { jobs: Record<string, JobInfo> }

export const createInitialToolStatusState = (): ToolStatusState => ({ jobs: {} })

// ─── Internal message protocol ───

type InternalMsg =
  | { type: '_jobRegistered'; jobId: string; info: JobInfo }
  | { type: '_jobCleared';    jobId: string }
  | {
      type:        '_statusReply'
      userReplyTo: ActorRef<ToolReply>
      jobId:       string
      reply:       ToolReply
      info:        JobInfo
    }

type Msg = ToolMsg | InternalMsg

// ─── Helpers ───

const formatAge = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

// ─── Actor ───

export const createToolStatusActor = (): ActorDef<Msg, ToolStatusState> => ({
  lifecycle: onLifecycle({
    start: (state, ctx) => {
      ctx.subscribe(JobRegistryTopic, (event) => {
        if (event.status === 'cleared') {
          return { type: '_jobCleared' as const, jobId: event.jobId }
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
          },
        }
      })
      return { state }
    },
  }),

  handler: onMessage<Msg, ToolStatusState>({
    _jobRegistered: (state, msg) => ({
      state: { jobs: { ...state.jobs, [msg.jobId]: msg.info } },
    }),

    _jobCleared: (state, msg) => {
      const { [msg.jobId]: _drop, ...rest } = state.jobs
      return { state: { jobs: rest } }
    },

    invoke: (state, msg, ctx) => {
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
          msg.replyTo.send({ type: 'toolResult', result: 'No active jobs.' })
          return { state }
        }
        const lines = entries.map(([id, j]) =>
          `- ${id} (${j.toolName}, running ${formatAge(Date.now() - j.startedAt)})`)
        msg.replyTo.send({ type: 'toolResult', result: lines.join('\n') })
        return { state }
      }

      const info = state.jobs[jobId]
      if (!info) {
        msg.replyTo.send({
          type: 'toolResult',
          result: `No active job with id ${jobId}. It may have already completed.`,
        })
        return { state }
      }

      // Forward a fresh jobStatus query to the underlying tool — the tool is the source of truth.
      ctx.pipeToSelf(
        ask<ToolMsg, ToolReply>(
          info.toolRef,
          (replyTo) => ({ type: 'jobStatus', jobId, replyTo }),
          { timeoutMs: 5000 },
        ),
        (reply) => ({ type: '_statusReply' as const, userReplyTo: msg.replyTo, jobId, reply, info }),
        (err)   => ({
          type: '_statusReply' as const,
          userReplyTo: msg.replyTo,
          jobId,
          reply: { type: 'toolError' as const, error: String(err) },
          info,
        }),
      )
      return { state }
    },

    jobStatus: (state, msg) => {
      // tool_status itself is not long-running. If something asks us this, decline.
      msg.replyTo.send({ type: 'toolError', error: 'tool_status does not run background jobs.' })
      return { state }
    },

    _statusReply: (state, msg) => {
      const age = formatAge(Date.now() - msg.info.startedAt)
      let text: string
      if (msg.reply.type === 'toolPending') {
        text = `Job ${msg.jobId} (${msg.info.toolName}) is still running, started ${age} ago.`
      } else if (msg.reply.type === 'toolResult') {
        text = `Job ${msg.jobId} (${msg.info.toolName}) completed (${age}): ${msg.reply.result}`
      } else {
        text = `Job ${msg.jobId} (${msg.info.toolName}) failed: ${msg.reply.error}`
      }
      msg.userReplyTo.send({ type: 'toolResult', result: text })
      return { state }
    },
  }),

  supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
})
