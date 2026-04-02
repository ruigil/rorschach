import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Server, ServerWebSocket } from 'bun'
import { emit } from '../../system/types.ts'
import {
  WsMessageTopic, WsConnectTopic, WsDisconnectTopic,
  WsSendTopic, WsBroadcastTopic, HttpConfigTopic, ConfigSnapshotTopic,
} from '../../types/ws.ts'
import type { HttpConfigPayload, ConfigSnapshotEvent } from '../../types/ws.ts'
import type { ActorDef, ActorRef, SpanHandle } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { ask } from '../../system/ask.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import { KgraphTopic } from '../../types/memory.ts'
import type { KgraphMsg, KgraphGraph } from '../../types/memory.ts'

// ─── Public directory (resolved relative to this module) ───
const PUBLIC_DIR = join(import.meta.dir, '../..', 'public')

// ─── Fallback model list (used when llm-provider is unavailable) ───
const FALLBACK_MODELS = [
  'anthropic/claude-haiku-4-5',
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-sonnet-4-5:thinking',
  'deepseek/deepseek-r1',
  'google/gemini-flash-1.5',
  'google/gemini-pro-1.5',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
]

// ─── Message protocol ───

export type HttpMessage =
  | { type: 'connected'; clientId: string }
  | { type: 'message'; clientId: string; text: string; images?: string[]; audio?: string }
  | { type: '_mediaSaved'; clientId: string; text: string; imagePaths: string[]; audioPath?: string }
  | { type: 'closed'; clientId: string }
  | { type: 'broadcast'; text: string }
  | { type: 'send'; clientId: string; text: string }
  | { type: 'config'; data: unknown }
  | { type: '_configSnapshot'; data: Record<string, unknown> }
  | { type: '_llmProviderChanged'; ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_kgraphChanged'; ref: ActorRef<KgraphMsg> | null }
  | { type: '_imageGenerated'; publicUrl: string }
  | { type: '_audioGenerated'; publicUrl: string }

// ─── Image helpers ───

const saveImagesToTempFiles = (images: string[]): Promise<string[]> =>
  Promise.all(images.map(async (dataUrl) => {
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/)
    const ext = match?.[1] ?? 'jpeg'
    const data = match?.[2] ?? ''
    const filePath = join(tmpdir(), `rorschach-${crypto.randomUUID()}.${ext}`)
    await Bun.write(filePath, Buffer.from(data, 'base64'))
    return filePath
  }))

const saveAudioToTempFile = async (dataUrl: string): Promise<string> => {
  const match = dataUrl.match(/^data:audio\/(\w+);base64,(.+)$/)
  const ext  = match?.[1] ?? 'wav'
  const data = match?.[2] ?? ''
  const filePath = join(tmpdir(), `rorschach-${crypto.randomUUID()}.${ext}`)
  await Bun.write(filePath, Buffer.from(data, 'base64'))
  return filePath
}

// ─── Actor state ───

export type HttpState = {
  server: Server<WsData> | null
  connections: number
  activeSpans: Record<string, SpanHandle>
  llmProviderRef: ActorRef<LlmProviderMsg> | null
  kgraphRef: ActorRef<KgraphMsg> | null
}

// ─── WebSocket attachment data ───

type WsData = { clientId: string }

// ─── Options ───

export type HttpActorOptions = {
  port?: number
}

// ─── MIME helper ───

const mimeType = (path: string): string => {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8'
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  if (path.endsWith('.js')) return 'application/javascript; charset=utf-8'
  if (path.endsWith('.json')) return 'application/json; charset=utf-8'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.ico')) return 'image/x-icon'
  if (path.endsWith('.wav')) return 'audio/wav'
  if (path.endsWith('.mp3')) return 'audio/mpeg'
  return 'application/octet-stream'
}

/**
 * Creates an HTTP + WebSocket actor definition.
 *
 * On the `start` lifecycle event, the actor starts a Bun HTTP server that:
 *   - serves static files from the `public/` directory at any GET path
 *   - upgrades `/ws` requests to WebSocket connections
 *
 * WebSocket events are bridged into the actor's mailbox via `self.send()`,
 * ensuring all processing happens sequentially in the actor's message loop.
 *
 * Incoming `ws:message` events are emitted as domain events (via `ActorResult.events`),
 * so any actor in the system can subscribe to this actor's topic to receive browser input.
 *
 * The `broadcast` message type pushes text to all connected WebSocket clients
 * using Bun's built-in pub/sub channel.
 */
export const createHttpActor = (
  options?: HttpActorOptions,
): ActorDef<HttpMessage, HttpState> => {
  const port = options?.port ?? 3000
  const CHANNEL = 'broadcast'

  // Mutable refs captured by Bun's server callbacks (which run outside the actor message loop)
  let selfRef: ActorRef<HttpMessage> | null = null
  let llmProviderRef: ActorRef<LlmProviderMsg> | null = null
  let kgraphRef: ActorRef<KgraphMsg> | null = null
  let configSnapshot: Record<string, unknown> | null = null

  return {
    handler: onMessage({

      connected: (state, message, context) => {
        const connections = state.connections + 1
        context.log.info(`client connected: ${message.clientId} (${connections} total)`)
        return {
          state: { ...state, connections },
          events: [emit(WsConnectTopic, { clientId: message.clientId })],
        }
      },

      message: (state, message, context) => {
        context.log.debug(`[${message.clientId}] ${message.text}`)
        const span = context.trace.start('request', { clientId: message.clientId })
        const newState = { ...state, activeSpans: { ...state.activeSpans, [message.clientId]: span } }

        if ((message.images && message.images.length > 0) || message.audio) {
          context.pipeToSelf(
            Promise.all([
              message.images && message.images.length > 0 ? saveImagesToTempFiles(message.images) : Promise.resolve([]),
              message.audio ? saveAudioToTempFile(message.audio) : Promise.resolve(undefined),
            ]).then(([imagePaths, audioPath]) => ({ imagePaths, audioPath })),
            ({ imagePaths, audioPath }): HttpMessage => ({ type: '_mediaSaved', clientId: message.clientId, text: message.text, imagePaths, audioPath }),
            (): HttpMessage => ({ type: '_mediaSaved', clientId: message.clientId, text: message.text, imagePaths: [] }),
          )
          return { state: newState }
        }

        return {
          state: newState,
          events: [emit(WsMessageTopic, {
            clientId: message.clientId,
            text: message.text,
            traceId: span.traceId,
            parentSpanId: span.spanId,
          })],
        }
      },

      _mediaSaved: (state, message) => {
        const { clientId, text, imagePaths, audioPath } = message
        const span = state.activeSpans[clientId]
        if (!span) return { state }
        return {
          state,
          events: [emit(WsMessageTopic, {
            clientId,
            text,
            images: imagePaths.length > 0 ? imagePaths : undefined,
            audio: audioPath,
            traceId: span.traceId,
            parentSpanId: span.spanId,
          })],
        }
      },

      closed: (state, message, context) => {
        const connections = Math.max(0, state.connections - 1)
        context.log.info(`client disconnected: ${message.clientId} (${connections} remaining)`)
        const span = state.activeSpans[message.clientId]
        if (span) {
          span.error('client disconnected')
          const { [message.clientId]: _, ...rest } = state.activeSpans
          return {
            state: { ...state, connections, activeSpans: rest },
            events: [emit(WsDisconnectTopic, { clientId: message.clientId })],
          }
        }
        return {
          state: { ...state, connections },
          events: [emit(WsDisconnectTopic, { clientId: message.clientId })],
        }
      },

      broadcast: (state, message) => {
        state.server?.publish(CHANNEL, message.text)
        return { state }
      },

      send: (state, message) => {
        state.server?.publish(`client:${message.clientId}`, message.text)
        try {
          const parsed = JSON.parse(message.text) as { type: string }
          if (parsed.type === 'done' || parsed.type === 'error') {
            const span = state.activeSpans[message.clientId]
            if (span) {
              parsed.type === 'done' ? span.done() : span.error()
              const { [message.clientId]: _, ...rest } = state.activeSpans
              return { state: { ...state, activeSpans: rest } }
            }
          }
        } catch { /* non-JSON text */ }
        return { state }
      },

      config: (state, message, context) => {
        context.log.debug('config update received via POST /config')
        return {
          state,
          events: [emit(HttpConfigTopic, message.data as HttpConfigPayload)],
        }
      },

      _configSnapshot: (state, message) => {
        configSnapshot = message.data
        return { state }
      },

      _llmProviderChanged: (state, message) => {
        llmProviderRef = message.ref
        return { state: { ...state, llmProviderRef: message.ref } }
      },

      _kgraphChanged: (state, message) => {
        kgraphRef = message.ref
        return { state: { ...state, kgraphRef: message.ref } }
      },


    }),

    lifecycle: onLifecycle({
      start: (state, context) => {
        selfRef = context.self

        context.subscribe(WsSendTopic, (e) => ({
          type: 'send' as const,
          clientId: e.clientId,
          text: e.text,
        }))

        context.subscribe(WsBroadcastTopic, (e) => ({
          type: 'broadcast' as const,
          text: e.text,
        }))

        context.subscribe(LlmProviderTopic, (e) => ({
          type: '_llmProviderChanged' as const,
          ref: e.ref,
        }))

        context.subscribe(KgraphTopic, (e) => ({
          type: '_kgraphChanged' as const,
          ref: e.ref,
        }))

        context.subscribe(ConfigSnapshotTopic, (e: ConfigSnapshotEvent) => ({
          type: '_configSnapshot' as const,
          data: e.config,
        }))


        const server = Bun.serve<WsData>({
          port,

          // ─── HTTP handler: static file serving ───
          async fetch(req, server) {
            const url = new URL(req.url)

            // Models API
            if (req.method === 'GET' && url.pathname === '/models') {
              if (llmProviderRef) {
                try {
                  const models = await ask(llmProviderRef, replyTo => ({ type: 'fetchModels' as const, replyTo }), { timeoutMs: 10_000 })
                  return new Response(JSON.stringify(models), { headers: { 'Content-Type': 'application/json' } })
                } catch { /* timeout — fall through to fallback */ }
              }
              return new Response(JSON.stringify(FALLBACK_MODELS), { headers: { 'Content-Type': 'application/json' } })
            }

            // Kgraph dump API
            if (req.method === 'GET' && url.pathname === '/kgraph') {
              const graph: KgraphGraph = kgraphRef
                ? await ask(kgraphRef, replyTo => ({ type: 'dump' as const, replyTo }), { timeoutMs: 5_000 })
                : { nodes: [], edges: [] }
              return new Response(JSON.stringify(graph), { headers: { 'Content-Type': 'application/json' } })
            }

            // Config API — GET returns current server config, POST applies changes
            if (req.method === 'GET' && url.pathname === '/config') {
              if (!configSnapshot) return new Response('Not ready', { status: 503 })
              return new Response(JSON.stringify(configSnapshot), { headers: { 'Content-Type': 'application/json' } })
            }

            if (req.method === 'POST' && url.pathname === '/config') {
              try {
                const data = await req.json()
                selfRef?.send({ type: 'config', data })
                return new Response(null, { status: 204 })
              } catch {
                return new Response('Invalid JSON', { status: 400 })
              }
            }

            // WebSocket upgrade
            if (url.pathname === '/ws') {
              const clientId = crypto.randomUUID()
              const upgraded = server.upgrade(req, { data: { clientId } })
              if (!upgraded) {
                return new Response('WebSocket upgrade failed', { status: 400 })
              }
              return undefined as unknown as Response
            }

            // Static file serving
            const filePath = url.pathname === '/'
              ? join(PUBLIC_DIR, 'index.html')
              : join(PUBLIC_DIR, url.pathname)

            const file = Bun.file(filePath)
            if (await file.exists()) {
              return new Response(file, {
                headers: { 'Content-Type': mimeType(filePath) },
              })
            }

            return new Response('Not Found', { status: 404 })
          },

          // ─── WebSocket handlers ───
          websocket: {
            open: (ws: ServerWebSocket<WsData>) => {
              ws.subscribe(CHANNEL)
              ws.subscribe(`client:${ws.data.clientId}`)
              selfRef?.send({ type: 'connected', clientId: ws.data.clientId })
            },
            message: (ws: ServerWebSocket<WsData>, message) => {
              const raw = typeof message === 'string' ? message : message.toString()
              let text = raw
              let images: string[] | undefined
              let audio: string | undefined
              try {
                const parsed = JSON.parse(raw) as { text?: string; images?: string[]; audio?: string }
                if (typeof parsed.text === 'string') {
                  text = parsed.text
                  images = parsed.images
                  audio = parsed.audio
                }
              } catch { /* plain text, no images */ }
              selfRef?.send({ type: 'message', clientId: ws.data.clientId, text, images, audio })
            },
            close: (ws: ServerWebSocket<WsData>) => {
              ws.unsubscribe(CHANNEL)
              selfRef?.send({ type: 'closed', clientId: ws.data.clientId })
            },
          },
        })

        context.log.info(`listening on http://localhost:${server.port}`)
        return { state: { ...state, server } }
      },

      stopped: (state, context) => {
        if (state.server) {
          context.log.info('stopping HTTP server')
          state.server.stop(true)
          return { state: { ...state, server: null } }
        }
        return { state }
      },
    }),
  }
}
