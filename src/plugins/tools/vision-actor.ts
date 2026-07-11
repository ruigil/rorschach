import type { ActorDef, ActorRef } from '../../system/index.ts'
import { onMessage, onLifecycle, ask } from '../../system/index.ts'
import { defineTool } from '../../system/index.ts'
import type { ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import { LlmProviderTopic, type LlmProviderMsg, type LlmProviderReply, type VisionProviderReply } from '../../types/llm.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult, type PObjGetPayload } from '../../types/persistence.ts'

// ─── Tool schemas ───

export const analyzeImageTool = defineTool('analyze_image', 'Analyze and describe the content of an image. Use when the user uploads an image or asks about a visual.', {
  type: 'object',
  properties: {
    image_url: { type: 'string', description: 'An object store key (e.g. "inbound/uuid.png" from attachments), a base64 data URL, or an HTTP URL.' },
    prompt: { type: 'string', description: 'Specific question or instruction about the image. Defaults to a general description.' },
  },
  required: ['image_url'],
})

export const generateImageTool = defineTool('generate_image', 'Generate an image from a text description. Use when the user asks to create, draw, or visualize something.', {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'Detailed description of the image to generate.' },
  },
  required: ['prompt'],
})

// ─── Messages ───

export type VisionMsg =
  | ToolInvokeMsg
  | LlmProviderReply
  | VisionProviderReply
  | { type: '_resolved';     requestId: string; imageUrl: string; prompt: string }
  | { type: '_resolveError'; requestId: string; error: string }
  | { type: '_imageSaved';   requestId: string; filePath: string; publicUrl: string }
  | { type: '_saveError';    requestId: string; error: string }
  | { type: '_llmProvider';  ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_persistenceRef'; ref: ActorRef<PersistenceMsg> | null }

// ─── State ───

type AnalysisPending = {
  kind: 'analysis'
  accumulated: string
  replyTo: ActorRef<ToolReply>
  userId?: string
}

type GenerationPending = {
  kind: 'generation'
  prompt: string
  streamController: ReadableStreamDefaultController<Uint8Array> | null
  replyTo: ActorRef<ToolReply>
  userId?: string
}

type PendingRequest = AnalysisPending | GenerationPending

export type VisionState = {
  pending: Record<string, PendingRequest>
  llmRef: ActorRef<LlmProviderMsg> | null
  persistenceRef: ActorRef<PersistenceMsg> | null
}

// ─── Options ───

export type VisionOptions = {
  llmRef?: ActorRef<LlmProviderMsg> | null
  persistenceRef?: ActorRef<PersistenceMsg> | null
  model: string
}

// ─── Helpers ───

const resolveImageUrl = async (
  persistenceRef: ActorRef<PersistenceMsg> | null,
  imageUrl: string
): Promise<string> => {
  if (imageUrl.startsWith('data:') || imageUrl.startsWith('http')) return imageUrl
  if (!persistenceRef) {
    throw new Error('Persistence provider not ready.')
  }
  const res = await ask<PersistenceMsg, PResult<PObjGetPayload>>(persistenceRef, (replyTo) => ({
    type: 'obj.get',
    bucket: 'media',
    key: imageUrl,
    replyTo,
  }))
  if (!res.ok) {
    throw new Error(`Failed to load image from persistence: ${res.error}`)
  }
  if (!res.data) {
    throw new Error('Failed to load image from persistence: No data')
  }
  const buf = res.data.data
  const ext = imageUrl.split('.').pop() ?? 'jpeg'
  const mimeType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mimeType};base64,${Buffer.from(buf).toString('base64')}`
}

const mimeTypeForImagePath = (path: string): string => {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'svg') return 'image/svg+xml'
  return 'image/png'
}

// ─── Actor definition ───

export const Vision = (options: VisionOptions): ActorDef<VisionMsg, VisionState> => {
  const { model } = options

  return {
    initialState: () => ({ pending: {}, llmRef: options.llmRef ?? null, persistenceRef: options.persistenceRef ?? null }),
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(LlmProviderTopic, (event) => ({ type: '_llmProvider' as const, ref: event.ref }))
        ctx.subscribe(PersistenceProviderTopic, (event) => ({ type: '_persistenceRef' as const, ref: event.ref }))
        return { state }
      },
    }),
    handler: onMessage<VisionMsg, VisionState>({

      _llmProvider: (state, msg) => {
        return { state: { ...state, llmRef: msg.ref } }
      },

      _persistenceRef: (state, msg) => {
        return { state: { ...state, persistenceRef: msg.ref } }
      },

      // ── analyze_image invoke ──
      invoke: (state, message, context) => {
        const { toolName, arguments: args, replyTo, userId } = message

        if (toolName === generateImageTool.name) {
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
          if (!state.llmRef) {
            replyTo.send({ type: 'toolError', error: 'Vision model provider not ready.' })
            return { state }
          }
          if (!state.persistenceRef) {
            replyTo.send({ type: 'toolError', error: 'Persistence provider not ready.' })
            return { state }
          }

          let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
          const imageStream = new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller
            }
          })

          const fileKey = `generated/${crypto.randomUUID()}.png`

          // Initiate the stream upload to persistence
          context.pipeToSelf(
            ask<PersistenceMsg, PResult>(state.persistenceRef, (replyTo) => ({
              type: 'obj.putStream' as const,
              bucket: 'media',
              key: fileKey,
              stream: imageStream,
              replyTo,
            })),
            () => ({ type: '_imageSaved' as const, requestId, filePath: fileKey, publicUrl: fileKey }),
            (error) => ({ type: '_saveError' as const, requestId, error: String(error) })
          )

          state.llmRef.send({
            type: 'streamImage',
            requestId,
            model,
            messages: [{ role: 'user', content: prompt }],
            role: 'vision',
            userId: userId,
            replyTo: context.self as unknown as ActorRef<VisionProviderReply>,
          })

          return {
            state: {
              ...state,
              pending: {
                ...state.pending,
                [requestId]: { kind: 'generation', prompt, streamController, replyTo, userId },
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
          resolveImageUrl(state.persistenceRef, imageUrl),
          (resolved) => ({ type: '_resolved' as const, requestId, imageUrl: resolved, prompt }),
          (error)    => ({ type: '_resolveError' as const, requestId, error: String(error) }),
        )
        return {
          state: {
            ...state,
            pending: { ...state.pending, [requestId]: { kind: 'analysis', accumulated: '', replyTo, userId } },
          },
        }
      },

      _resolved: (state, message, context) => {
        const { requestId, imageUrl, prompt } = message
        const req = state.pending[requestId]
        context.log.info('vision: image URL resolved, sending to LLM', { requestId })
        if (!state.llmRef) {
          req?.replyTo.send({ type: 'toolError', error: 'Vision model provider not ready.' })
          return { state }
        }
        state.llmRef.send({
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
          userId: req?.userId,
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
        const snippet = req.prompt.length > 300 ? `${req.prompt.slice(0, 300)}…` : req.prompt
        const text = `Generated an image from prompt: "${snippet}" and delivered it to the user as an attachment.`
        req.replyTo.send({
          type: 'toolResult',
          result: {
            text,
            attachments: [{
              kind: 'image',
              url: message.publicUrl,
              name: message.publicUrl.split('/').pop(),
              mimeType: mimeTypeForImagePath(message.publicUrl),
              alt: snippet,
            }],
          },
        })
        return { state: { ...state, pending: rest } }
      },

      _saveError: (state, message, context) => {
        const { [message.requestId]: req, ...rest } = state.pending
        if (!req) return { state }
        context.log.error('vision: failed to save generated image', { error: message.error })
        req.replyTo.send({ type: 'toolError', error: `Failed to save image: ${message.error}` })
        return { state: { ...state, pending: rest } }
      },

      llmDone: (state, message, context) => {
        const req = state.pending[message.requestId]
        if (!req) return { state }

        if (req.kind === 'analysis') {
          context.log.info('vision: analysis complete', { requestId: message.requestId })
          req.replyTo.send({ type: 'toolResult', result: { text: req.accumulated || 'No description available.' } })
          const { [message.requestId]: _, ...rest } = state.pending
          return { state: { ...state, pending: rest } }
        }

        // Generation: close stream
        if (req.kind === 'generation' && req.streamController) {
          try {
            req.streamController.close()
          } catch (e) {
            context.log.error('Failed to close stream controller', { error: String(e) })
          }
        }
        return { state }
      },

      llmChunk: (state, message) => {
        const req = state.pending[message.requestId]
        if (!req || req.kind !== 'analysis') return { state }
        return {
          state: {
            ...state,
            pending: { ...state.pending, [message.requestId]: { ...req, accumulated: req.accumulated + message.text } },
          },
        }
      },

      llmImageChunk: (state, message) => {
        const req = state.pending[message.requestId]
        if (!req || req.kind !== 'generation' || !req.streamController) return { state }
        
        let base64Data = message.dataUrl
        const match = base64Data.match(/^data:image\/(\w+);base64,(.+)$/)
        if (match && match[2]) {
          base64Data = match[2]
        }
        const rawBytes = Buffer.from(base64Data, 'base64')
        req.streamController.enqueue(new Uint8Array(rawBytes))
        
        return { state }
      },

      llmError: (state, message, context) => {
        const { [message.requestId]: req, ...rest } = state.pending
        if (!req) return { state }
        context.log.error('vision llm error', { error: String(message.error) })
        
        // If it was a generation, close the stream on error
        if (req.kind === 'generation' && req.streamController) {
          try {
            req.streamController.close()
          } catch {}
        }
        
        req.replyTo.send({ type: 'toolError', error: String(message.error) })
        return { state: { ...state, pending: rest } }
      },

    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
