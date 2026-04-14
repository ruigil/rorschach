import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onMessage } from '../../system/match.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from '../../types/tools.ts'
import type { LlmProviderMsg, LlmProviderReply, VisionProviderReply } from '../../types/llm.ts'

// ─── Output directory for generated images ───

const GENERATED_DIR = join(import.meta.dir, '../../public/generated')
const GENERATED_PUBLIC_PREFIX = 'generated'

// ─── Tool schemas ───

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

export const GENERATE_IMAGE_TOOL_NAME = 'generate_image'

export const GENERATE_IMAGE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: GENERATE_IMAGE_TOOL_NAME,
    description: 'Generate an image from a text description. Use when the user asks to create, draw, or visualize something.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed description of the image to generate.' },
      },
      required: ['prompt'],
    },
  },
}

// ─── Messages ───

export type VisionActorMsg =
  | ToolInvokeMsg
  | LlmProviderReply
  | VisionProviderReply
  | { type: '_resolved';     requestId: string; imageUrl: string; prompt: string }
  | { type: '_resolveError'; requestId: string; error: string }
  | { type: '_imageSaved';   requestId: string; filePath: string; publicUrl: string }
  | { type: '_saveError';    requestId: string; error: string }

// ─── State ───

type AnalysisPending = {
  kind: 'analysis'
  accumulated: string
  replyTo: ActorRef<ToolReply>
  clientId?: string
}

type GenerationPending = {
  kind: 'generation'
  accumulatedText: string
  accumulatedImage: string
  replyTo: ActorRef<ToolReply>
  clientId?: string
}

type PendingRequest = AnalysisPending | GenerationPending

export type VisionState = {
  pending: Record<string, PendingRequest>
}

// ─── Options ───

export type VisionActorOptions = {
  llmRef: ActorRef<LlmProviderMsg>
  model: string
}

// ─── Helpers ───

const resolveImageUrl = async (imageUrl: string): Promise<string> => {
  if (imageUrl.startsWith('data:') || imageUrl.startsWith('http')) return imageUrl
  const buf = await Bun.file(imageUrl).bytes()
  const ext = imageUrl.split('.').pop() ?? 'jpeg'
  const mimeType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mimeType};base64,${Buffer.from(buf).toString('base64')}`
}

const saveGeneratedImage = async (dataUrl: string): Promise<{ filePath: string; publicUrl: string }> => {
  const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/)
  const ext    = match?.[1] ?? 'png'
  const data   = match?.[2] ?? ''
  const name   = `${crypto.randomUUID()}.${ext}`
  await mkdir(GENERATED_DIR, { recursive: true })
  const filePath  = join(GENERATED_DIR, name)
  await Bun.write(filePath, Buffer.from(data, 'base64'))
  return { filePath, publicUrl: `${GENERATED_PUBLIC_PREFIX}/${name}` }
}

// ─── Actor definition ───

export const createVisionActor = (options: VisionActorOptions): ActorDef<VisionActorMsg, VisionState> => {
  const { llmRef, model } = options

  return {
    handler: onMessage<VisionActorMsg, VisionState>({

      // ── analyze_image invoke ──
      invoke: (state, message, context) => {
        const { toolName, arguments: args, replyTo, clientId } = message

        if (toolName === GENERATE_IMAGE_TOOL_NAME) {
          let prompt = ''
          try {
            const parsed = JSON.parse(args) as { prompt: string }
            prompt = parsed.prompt
          } catch {
            replyTo.send({ type: 'toolError', error: 'Invalid arguments: expected JSON with prompt' })
            return { state }
          }

          const requestId = crypto.randomUUID()
          context.log.info('vision: generating image', { requestId, prompt })
          llmRef.send({
            type: 'streamImage',
            requestId,
            model,
            messages: [{ role: 'user', content: prompt }],
            role: 'vision',
            clientId,
            replyTo: context.self as unknown as ActorRef<VisionProviderReply>,
          })
          return {
            state: {
              ...state,
              pending: {
                ...state.pending,
                [requestId]: { kind: 'generation', accumulatedText: '', accumulatedImage: '', replyTo, clientId },
              },
            },
          }
        }

        // Default: analyze_image
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
        context.log.info('vision: analyzing image', { requestId, imageUrl, prompt })
        context.pipeToSelf(
          resolveImageUrl(imageUrl),
          (resolved) => ({ type: '_resolved' as const, requestId, imageUrl: resolved, prompt }),
          (error)    => ({ type: '_resolveError' as const, requestId, error: String(error) }),
        )
        return {
          state: {
            ...state,
            pending: { ...state.pending, [requestId]: { kind: 'analysis', accumulated: '', replyTo, clientId } },
          },
        }
      },

      _resolved: (state, message, context) => {
        const { requestId, imageUrl, prompt } = message
        const req = state.pending[requestId]
        context.log.info('vision: image URL resolved, sending to LLM', { requestId })
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
          role: 'vision',
          clientId: req?.clientId,
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

      _imageSaved: (state, message, context) => {
        const { [message.requestId]: req, ...rest } = state.pending
        if (!req || req.kind !== 'generation') return { state }
        context.log.info('vision: image saved', { requestId: message.requestId, publicUrl: message.publicUrl })
        const rawDescription = (req.accumulatedText || 'Image generated successfully.')
          .replace(/generated_image_url_placeholder/g, message.publicUrl)
        const result = `![Generated Image](${message.publicUrl})\n\n${rawDescription}`
        req.replyTo.send({ type: 'toolResult', result })
        return { state: { ...state, pending: rest } }
      },

      _saveError: (state, message, context) => {
        const { [message.requestId]: req, ...rest } = state.pending
        if (!req) return { state }
        context.log.error('vision: failed to save generated image', { error: message.error })
        req.replyTo.send({ type: 'toolError', error: `Failed to save image: ${message.error}` })
        return { state: { ...state, pending: rest } }
      },

      llmChunk: (state, message) => {
        const req = state.pending[message.requestId]
        if (!req) return { state }
        if (req.kind === 'analysis') {
          return {
            state: {
              ...state,
              pending: { ...state.pending, [message.requestId]: { ...req, accumulated: req.accumulated + message.text } },
            },
          }
        }
        // generation — accumulate description text
        return {
          state: {
            ...state,
            pending: { ...state.pending, [message.requestId]: { ...req, accumulatedText: req.accumulatedText + message.text } },
          },
        }
      },

      llmImageChunk: (state, message) => {
        const req = state.pending[message.requestId]
        if (!req || req.kind !== 'generation') return { state }
        // Keep the last image chunk (the final complete PNG data URL)
        return {
          state: {
            ...state,
            pending: { ...state.pending, [message.requestId]: { ...req, accumulatedImage: message.dataUrl } },
          },
        }
      },

      llmDone: (state, message, context) => {
        const { [message.requestId]: req, ...rest } = state.pending
        if (!req) return { state }

        if (req.kind === 'analysis') {
          context.log.info('vision: analysis complete', { requestId: message.requestId })
          req.replyTo.send({ type: 'toolResult', result: req.accumulated || 'No description available.' })
          return { state: { ...state, pending: rest } }
        }

        // generation — save image to disk, then reply via _imageSaved
        if (!req.accumulatedImage) {
          context.log.error('vision: image generation completed but no image data received')
          req.replyTo.send({ type: 'toolError', error: 'No image data received from model.' })
          return { state: { ...state, pending: rest } }
        }

        // Keep the pending entry alive until the file is saved
        context.log.info('vision: generation complete, saving image', { requestId: message.requestId })
        context.pipeToSelf(
          saveGeneratedImage(req.accumulatedImage),
          (r) => ({ type: '_imageSaved'  as const, requestId: message.requestId, filePath: r.filePath, publicUrl: r.publicUrl }),
          (e) => ({ type: '_saveError'   as const, requestId: message.requestId, error: String(e) }),
        )
        return { state }
      },

      llmError: (state, message, context) => {
        const { [message.requestId]: req, ...rest } = state.pending
        if (!req) return { state }
        context.log.error('vision llm error', { error: String(message.error) })
        req.replyTo.send({ type: 'toolError', error: String(message.error) })
        return { state: { ...state, pending: rest } }
      },

    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
