import { unlink } from 'node:fs/promises'
import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from '../../system/tools.ts'
import { ToolRegistrationTopic } from '../../system/tools.ts'
import type { LlmProviderMsg, LlmProviderReply } from './llm-provider.ts'

// ─── Tool schema ───

export const ANALYZE_IMAGE_TOOL_NAME = 'analyze_image'

export const ANALYZE_IMAGE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: ANALYZE_IMAGE_TOOL_NAME,
    description: 'Analyze and describe the content of an image. Use when the user uploads an image or asks about a visual.',
    parameters: {
      type: 'object',
      properties: {
        image_url: { type: 'string', description: 'An image ID (e.g. "img_0") from the current turn, a base64 data URL, or an HTTP URL.' },
        prompt: { type: 'string', description: 'Specific question or instruction about the image. Defaults to a general description.' },
      },
      required: ['image_url'],
    },
  },
}

// ─── Messages ───

export type VisionActorMsg =
  | ToolInvokeMsg
  | LlmProviderReply
  | { type: '_resolved'; requestId: string; imageUrl: string; prompt: string }
  | { type: '_resolveError'; requestId: string; error: string }

// ─── State ───

type PendingRequest = {
  accumulated: string
  replyTo: ActorRef<ToolReply>
}

export type VisionState = {
  pending: Record<string, PendingRequest>  // requestId → in-flight request
}

// ─── Options ───

export type VisionActorOptions = {
  llmRef: ActorRef<LlmProviderMsg>
  model: string
}

// ─── File → data URL resolution ───

const resolveImageUrl = async (imageUrl: string): Promise<string> => {
  if (imageUrl.startsWith('data:') || imageUrl.startsWith('http')) return imageUrl
  // Treat as a local file path: read, encode, delete
  const buf = await Bun.file(imageUrl).bytes()
  const ext = imageUrl.split('.').pop() ?? 'jpeg'
  const mimeType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
  await unlink(imageUrl)
  return `data:${mimeType};base64,${Buffer.from(buf).toString('base64')}`
}

// ─── Actor definition ───

export const createVisionActor = (options: VisionActorOptions): ActorDef<VisionActorMsg, VisionState> => {
  const { llmRef, model } = options

  return {
    lifecycle: onLifecycle({
      start: (state, context) => {
        context.publish(ToolRegistrationTopic, {
          name: ANALYZE_IMAGE_TOOL_NAME,
          schema: ANALYZE_IMAGE_SCHEMA,
          ref: context.self as unknown as ActorRef<ToolInvokeMsg>,
        })
        context.log.info('vision actor ready', { model })
        return { state }
      },

      stopped: (state, context) => {
        context.publish(ToolRegistrationTopic, { name: ANALYZE_IMAGE_TOOL_NAME, ref: null })
        return { state }
      },
    }),

    handler: onMessage<VisionActorMsg, VisionState>({
      invoke: (state, message, context) => {
        const { arguments: args, replyTo } = message
        let imageUrl = ''
        let prompt = 'Describe this image in detail.'
        try {
          const parsed = JSON.parse(args) as { image_url: string; prompt?: string }
          imageUrl = parsed.image_url
          if (parsed.prompt) prompt = parsed.prompt
        } catch {
          replyTo.send({ type: 'toolError', error: 'Invalid arguments: expected JSON with image_url' })
          return { state }
        }

        const requestId = crypto.randomUUID()
        context.pipeToSelf(
          resolveImageUrl(imageUrl),
          (resolved) => ({ type: '_resolved' as const, requestId, imageUrl: resolved, prompt }),
          (error)    => ({ type: '_resolveError' as const, requestId, error: String(error) }),
        )
        return {
          state: { ...state, pending: { ...state.pending, [requestId]: { accumulated: '', replyTo } } },
        }
      },

      _resolved: (state, message, context) => {
        const { requestId, imageUrl, prompt } = message
        llmRef.send({
          type: 'stream',
          requestId,
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: imageUrl } },
                { type: 'text', text: prompt },
              ],
            },
          ],
          replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
        })
        return { state }
      },

      _resolveError: (state, message, context) => {
        const { [message.requestId]: req, ...rest } = state.pending
        if (!req) return { state }
        context.log.error('vision: failed to resolve image', { error: message.error })
        req.replyTo.send({ type: 'toolError', error: `Failed to load image: ${message.error}` })
        return { state: { ...state, pending: rest } }
      },

      llmChunk: (state, message) => {
        const req = state.pending[message.requestId]
        if (!req) return { state }
        return {
          state: {
            ...state,
            pending: { ...state.pending, [message.requestId]: { ...req, accumulated: req.accumulated + message.text } },
          },
        }
      },

      llmDone: (state, message) => {
        const { [message.requestId]: req, ...rest } = state.pending
        if (!req) return { state }
        req.replyTo.send({ type: 'toolResult', result: req.accumulated || 'No description available.' })
        return { state: { ...state, pending: rest } }
      },

      llmError: (state, message, context) => {
        const { [message.requestId]: req, ...rest } = state.pending
        if (!req) return { state }
        context.log.error('vision llm error', { error: String(message.error) })
        req.replyTo.send({ type: 'toolError', error: String(message.error) })
        return { state: { ...state, pending: rest } }
      },

      llmToolCalls: (state, message, context) => {
        const { [message.requestId]: req, ...rest } = state.pending
        if (!req) return { state }
        context.log.warn('vision model returned unexpected tool calls')
        req.replyTo.send({ type: 'toolError', error: 'Vision model returned unexpected tool calls' })
        return { state: { ...state, pending: rest } }
      },

      llmReasoningChunk: (state) => ({ state }),
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
