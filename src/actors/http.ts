import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server, ServerWebSocket } from 'bun'
import { createTopic, emit } from '../system/types.ts'
import type { ActorDef, ActorRef } from '../system/types.ts'

// ─── Public directory (resolved relative to this module) ───
const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(__dirname+"/..", 'public')

// ─── Message protocol ───

export type HttpMessage =
  | { type: 'ws:connected'; clientId: string }
  | { type: 'ws:message'; clientId: string; text: string }
  | { type: 'ws:closed'; clientId: string }
  | { type: 'broadcast'; text: string }

// ─── Actor state ───

export type HttpState = {
  server: Server<WsData> | null
  connections: number
}

// ─── WebSocket attachment data ───

type WsData = { clientId: string }

// ─── Domain event: published when a WebSocket message is received ───

export type WsMessageEvent = { clientId: string; text: string }

/** Topic for WebSocket message domain events. Subscribe to receive browser input. */
export const WsMessageTopic = createTopic<WsMessageEvent>('http.ws.message')

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
 * In `setup`, the actor starts a Bun HTTP server that:
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

  // We capture the actor's self ref during setup so WS callbacks can route into the mailbox
  let selfRef: ActorRef<HttpMessage> | null = null

  return {
    setup: (state, context) => {
      selfRef = context.self

      const server = Bun.serve<WsData>({
        port,

        // ─── HTTP handler: static file serving ───
        async fetch(req, server) {
          const url = new URL(req.url)

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
          open(ws: ServerWebSocket<WsData>) {
            ws.subscribe(CHANNEL)
            selfRef?.send({ type: 'ws:connected', clientId: ws.data.clientId })
          },

          message(ws: ServerWebSocket<WsData>, message) {
            const text = typeof message === 'string' ? message : message.toString()
            selfRef?.send({ type: 'ws:message', clientId: ws.data.clientId, text })
          },

          close(ws: ServerWebSocket<WsData>) {
            ws.unsubscribe(CHANNEL)
            selfRef?.send({ type: 'ws:closed', clientId: ws.data.clientId })
          },
        },
      })

      context.log.info(`listening on http://localhost:${server.port}`)

      return { ...state, server }
    },

    handler: (state, message, context) => {
      switch (message.type) {
        case 'ws:connected': {
          const connections = state.connections + 1
          context.log.info(`client connected: ${message.clientId} (${connections} total)`)
          return { state: { ...state, connections } }
        }

        case 'ws:message': {
          context.log.debug(`[${message.clientId}] ${message.text}`)

          // Echo back to all connected clients via Bun pub/sub
          state.server?.publish(CHANNEL, message.text)

          // Emit as a typed domain event so other actors can subscribe
          return {
            state,
            events: [emit(WsMessageTopic, { clientId: message.clientId, text: message.text })],
          }
        }

        case 'ws:closed': {
          const connections = Math.max(0, state.connections - 1)
          context.log.info(`client disconnected: ${message.clientId} (${connections} remaining)`)
          return { state: { ...state, connections } }
        }

        case 'broadcast': {
          state.server?.publish(CHANNEL, message.text)
          return { state }
        }
      }
    },

    lifecycle: (state, event, context) => {
      if (event.type === 'stopped' && state.server) {
        context.log.info('stopping HTTP server')
        state.server.stop(true)
        return { state: { ...state, server: null } }
      }
      return { state }
    },
  }
}
