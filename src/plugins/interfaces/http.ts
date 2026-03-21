import { join } from 'node:path'
import type { Server, ServerWebSocket } from 'bun'
import { createTopic, emit } from '../../system/types.ts'
import type { ActorDef, ActorRef, SpanHandle } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'

// ─── Public directory (resolved relative to this module) ───
const PUBLIC_DIR = join(import.meta.dir, '../..', 'public')

// ─── Message protocol ───

export type HttpMessage =
  | { type: 'connected'; clientId: string }
  | { type: 'message'; clientId: string; text: string }
  | { type: 'closed'; clientId: string }
  | { type: 'broadcast'; text: string }
  | { type: 'send'; clientId: string; text: string }
  | { type: 'config'; data: unknown }

// ─── Actor state ───

export type HttpState = {
  server: Server<WsData> | null
  connections: number
  activeSpans: Record<string, SpanHandle>
}

// ─── WebSocket attachment data ───

type WsData = { clientId: string }

// ─── Domain event: published when a WebSocket message is received ───

export type WsMessageEvent = { clientId: string; text: string; traceId: string; parentSpanId: string }

/** Topic for WebSocket message domain events. Subscribe to receive browser input. */
export const WsMessageTopic = createTopic<WsMessageEvent>('http.ws.message')

// ─── Domain event: emit to send a message to a specific WebSocket client ───

export type WsSendEvent = { clientId: string; text: string }

/** Topic for sending a message to a specific WebSocket client. Emit to push text to the browser. */
export const WsSendTopic = createTopic<WsSendEvent>('http.ws.send')

// ─── Domain event: emit to broadcast a message to all connected WebSocket clients ───

export type WsBroadcastEvent = { text: string }

/** Topic for broadcasting a message to all WebSocket clients. Emit to push text to every open connection. */
export const WsBroadcastTopic = createTopic<WsBroadcastEvent>('http.ws.broadcast')

// ─── Domain event: emitted when a POST /config request is received ───

export type HttpConfigPayload = Record<string, unknown>

/** Topic emitted when the browser POSTs new config. Subscribe in your app to apply config changes. */
export const HttpConfigTopic = createTopic<HttpConfigPayload>('http.config.post')

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

  // We capture the actor's self ref during start so WS callbacks can route into the mailbox
  let selfRef: ActorRef<HttpMessage> | null = null

  return {
    handler: onMessage({

      connected: (state, message, context) => {
        const connections = state.connections + 1
        context.log.info(`client connected: ${message.clientId} (${connections} total)`)
        return { state: { ...state, connections } }
      },

      message: (state, message, context) => {
        context.log.debug(`[${message.clientId}] ${message.text}`)
        const span = context.trace.start('request', { clientId: message.clientId })
        return {
          state: { ...state, activeSpans: { ...state.activeSpans, [message.clientId]: span } },
          events: [emit(WsMessageTopic, {
            clientId: message.clientId,
            text: message.text,
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
          return { state: { ...state, connections, activeSpans: rest } }
        }
        return { state: { ...state, connections } }
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

        const server = Bun.serve<WsData>({
          port,

          // ─── HTTP handler: static file serving ───
          async fetch(req, server) {
            const url = new URL(req.url)

            // Config API
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
              const text = typeof message === 'string' ? message : message.toString()
              selfRef?.send({ type: 'message', clientId: ws.data.clientId, text })
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
