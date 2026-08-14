import type { ActorDef, ActorRef } from '../../system/index.ts'
import { onMessage, onLifecycle } from '../../system/index.ts'
import { JobRegistryTopic } from '../../types/tools.ts'
import { defineTool } from '../../system/index.ts'
import { LlmProviderTopic, type LlmProviderMsg, type VideoSubmitReply, type VideoPollReply, type VideoDownloadReply } from '../../types/llm.ts'
import { PersistenceProviderTopic } from '../../types/persistence.ts'
import type { PersistenceMsg } from '../../types/persistence.ts'
import type { VideoMsg, VideoState, VideoOptions, PendingJob } from './types.ts'

// ─── Tool schema ───

export const generateVideoTool = defineTool('tools_video_generate', 'Generate a video from a text description. Use when the user asks to create, animate, or render video content. This is a long-running operation — it may take several minutes.', {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'Detailed description of the video to generate.' },
  },
  required: ['prompt'],
})

const DEFAULT_ASPECT_RATIO = '16:9'
const DEFAULT_DURATION = 4
const DEFAULT_RESOLUTION = '720p'
const DEFAULT_POLL_INTERVAL_MS = 5000
const DEFAULT_POLL_TIMEOUT_MS = 600_000

// ─── Actor definition ───

export const Video = (options: VideoOptions): ActorDef<VideoMsg, VideoState> => {
  const {
    model,
    aspectRatio = DEFAULT_ASPECT_RATIO,
    duration = DEFAULT_DURATION,
    resolution = DEFAULT_RESOLUTION,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  } = options

  const videoPollRole = 'video'

  return {
    initialState: () => ({ pending: {}, llmRef: options.llmRef ?? null, persistenceRef: null }),
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(LlmProviderTopic, (event) => ({ type: '_llmProvider' as const, ref: event.ref }))
        ctx.subscribe(PersistenceProviderTopic, (event) => ({ type: '_persistenceRef' as const, ref: event.ref }))
        return { state }
      },
    }),
    handler: onMessage<VideoMsg, VideoState>({

      _llmProvider: (state, msg) => {
        return { state: { ...state, llmRef: msg.ref } }
      },

      _persistenceRef: (state, msg) => {
        return { state: { ...state, persistenceRef: msg.ref } }
      },

      invoke: (state, message, context) => {
        const { input, replyTo } = message

        let prompt = ''
        if (typeof input === 'string') {
          try {
            const parsed = JSON.parse(input) as { prompt?: string }
            prompt = parsed.prompt || input
          } catch {
            prompt = input
          }
        } else if (input && typeof input === 'object' && 'prompt' in input) {
          prompt = String((input as { prompt: unknown }).prompt ?? '')
        }

        if (!prompt) {
          replyTo.send({ type: 'error', error: 'Invalid arguments: prompt is required' })
          return { state }
        }

        const requestId = crypto.randomUUID()
        context.log.info('video: submitting generation request', { requestId, model, prompt, aspectRatio, duration, resolution })
        if (!state.llmRef) {
          replyTo.send({ type: 'error', error: 'Video model provider not ready.' })
          return { state }
        }
        const resolvedUserId = context.request.userId
        context.send(state.llmRef, {
          type: 'submitVideo',
          requestId,
          model,
          prompt,
          aspectRatio,
          duration,
          resolution,
          role: videoPollRole,
          replyTo: context.self as unknown as ActorRef<VideoSubmitReply>,
        })
        return {
          state: {
            ...state,
            pending: { ...state.pending, [requestId]: { requestId, jobId: '', pollingUrl: '', replyTo, userId: resolvedUserId, deadline: 0 } },
          },
        }
      },

      videoSubmitted: (state, message, context) => {
        const { requestId, jobId, pollingUrl } = message
        const req = state.pending[requestId]
        if (!req) return { state }

        context.log.info('video: job submitted, starting poll', { requestId, jobId, pollingUrl })
        const deadline = Date.now() + pollTimeoutMs
        req.replyTo.send({ type: 'pending', jobId, placeholderText: `Video generation started (jobId=${jobId}).` })

        if (!state.llmRef) {
          req.replyTo.send({ type: 'error', error: 'Video model provider not ready.' })
          return { state }
        }
        context.send(state.llmRef, {
          type: 'pollVideo',
          requestId,
          pollingUrl,
          role: videoPollRole,
          replyTo: context.self as unknown as ActorRef<VideoPollReply>,
        })
        return {
          state: {
            ...state,
            pending: { ...state.pending, [requestId]: { ...req, jobId, pollingUrl, deadline } },
          },
        }
      },

      videoSubmitError: (state, message, context) => {
        const { requestId, error } = message
        const { [requestId]: req, ...rest } = state.pending
        if (!req) return { state }
        context.log.error('video: submit failed', { requestId, error })
        req.replyTo.send({ type: 'error', error: `Video generation request failed: ${error}` })
        return { state: { ...state, pending: rest } }
      },

      videoPollResult: (state, message, context) => {
        const { requestId, status, unsigned_urls, error } = message
        const req = state.pending[requestId]
        if (!req) return { state }

        if (status === 'completed') {
          if (!unsigned_urls || unsigned_urls.length === 0) {
            context.log.error('video: completed but no video URLs', { requestId, jobId: req.jobId })
            context.publishRetained(JobRegistryTopic, req.jobId, { jobId: req.jobId, status: 'failed', error: 'No video URLs returned' })
            const { [requestId]: _, ...rest } = state.pending
            return { state: { ...state, pending: rest } }
          }

          if (!state.persistenceRef) {
            context.log.error('video: persistence not ready for download', { requestId, jobId: req.jobId })
            context.publishRetained(JobRegistryTopic, req.jobId, { jobId: req.jobId, status: 'failed', error: 'Persistence provider not ready' })
            const { [requestId]: _, ...rest } = state.pending
            return { state: { ...state, pending: rest } }
          }

          const downloads = unsigned_urls.map((url) => ({
            url,
            key: `generated/${crypto.randomUUID()}.mp4`,
          }))
          context.log.info('video: downloading via persistence', { requestId, jobId: req.jobId, count: downloads.length })
          if (!state.llmRef) {
            context.publishRetained(JobRegistryTopic, req.jobId, { jobId: req.jobId, status: 'failed', error: 'Video model provider not ready.' })
            const { [requestId]: _, ...rest } = state.pending
            return { state: { ...state, pending: rest } }
          }
          context.send(state.llmRef, {
            type: 'downloadVideos',
            requestId,
            downloads,
            bucket: 'media',
            persistenceRef: state.persistenceRef,
            role: videoPollRole,
            replyTo: context.self as unknown as ActorRef<VideoDownloadReply>,
          })
          return { state }
        }

        if (status === 'failed') {
          context.log.error('video: generation failed', { requestId, jobId: req.jobId, error })
          context.publishRetained(JobRegistryTopic, req.jobId, { jobId: req.jobId, status: 'failed', error: error ?? 'Unknown error' })
          const { [requestId]: _, ...rest } = state.pending
          return { state: { ...state, pending: rest } }
        }

        // Still processing — schedule next poll
        context.log.info('video: still processing, scheduling next poll', { requestId, jobId: req.jobId })
        context.timers.startSingleTimer(`video_poll:${requestId}`, { type: '_pollTick', requestId }, pollIntervalMs)
        return { state }
      },

      videoPollError: (state, message, context) => {
        const { requestId, error } = message
        const req = state.pending[requestId]
        if (!req) return { state }
        context.log.error('video: poll error', { requestId, jobId: req.jobId, error })
        context.publishRetained(JobRegistryTopic, req.jobId, { jobId: req.jobId, status: 'failed', error: `Poll error: ${error}` })
        const { [requestId]: _, ...rest } = state.pending
        return { state: { ...state, pending: rest } }
      },

      _pollTick: (state, message, context) => {
        const { requestId } = message
        const req = state.pending[requestId]
        if (!req) return { state }

        if (Date.now() >= req.deadline) {
          context.log.error('video: poll timed out', { requestId, jobId: req.jobId, durationMs: Date.now() - (req.deadline - pollTimeoutMs) })
          context.publishRetained(JobRegistryTopic, req.jobId, { jobId: req.jobId, status: 'failed', error: 'Video generation timed out' })
          const { [requestId]: _, ...rest } = state.pending
          return { state: { ...state, pending: rest } }
        }

        if (!state.llmRef) {
          context.publishRetained(JobRegistryTopic, req.jobId, { jobId: req.jobId, status: 'failed', error: 'Video model provider not ready.' })
          const { [requestId]: _, ...rest } = state.pending
          return { state: { ...state, pending: rest } }
        }
        context.send(state.llmRef, {
          type: 'pollVideo',
          requestId,
          pollingUrl: req.pollingUrl,
          role: videoPollRole,
          replyTo: context.self as unknown as ActorRef<VideoPollReply>,
        })
        return { state }
      },

      videosDownloaded: (state, message, context) => {
        const { requestId, keys } = message
        const req = state.pending[requestId]
        if (!req) return { state }

        context.log.info('video: download complete to persistence', { requestId, jobId: req.jobId, count: keys.length })

        const attachments = keys.map((key, i) => ({
          kind: 'video' as const,
          url: key,
          alt: keys.length > 1 ? `Video ${i + 1}` : 'Generated Video',
        }))

        context.publishRetained(JobRegistryTopic, req.jobId, {
          jobId: req.jobId,
          status: 'completed',
          result: { text: 'Video generation completed.', attachments },
        })
        const { [requestId]: _, ...rest } = state.pending
        return { state: { ...state, pending: rest } }
      },

      videoDownloadError: (state, message, context) => {
        const { requestId, error } = message
        const req = state.pending[requestId]
        if (!req) return { state }
        context.log.error('video: download failed', { requestId, jobId: req.jobId, error })
        context.publishRetained(JobRegistryTopic, req.jobId, { jobId: req.jobId, status: 'failed', error: `Download failed: ${error}` })
        const { [requestId]: _, ...rest } = state.pending
        return { state: { ...state, pending: rest } }
      },

    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
