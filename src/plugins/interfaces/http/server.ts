import { join } from 'node:path'
import type { Server, ServerWebSocket } from 'bun'
import { mimeType, safeJoinUrlPath } from './media.ts'
import type { MessageAttachment } from '../../../types/events.ts'
import type { Identity } from '../../../types/identity.ts'
import { ask } from '../../../system/index.ts'
import type { ActorRef } from '../../../system/index.ts'
import type { HttpRequestMsg, HttpResponseMsg } from '../../../types/routes.ts'

export type WsData = { clientId: string; userId: string; roles: string[] }

export type ServerOptions = {
  port: number
  PUBLIC_DIR: string
  MEDIA_DIR: string
  checkAdmin: (roles: readonly string[]) => boolean
  resolveIdentity: (ticket: string) => Promise<Identity | null>
  resolveCookieIdentity: (req: Request) => Promise<Identity | null>
  authorizeConfigAccess: (req: Request, url: URL, identity: Identity | null, options?: { requireSameOrigin?: boolean }) => Promise<Response | null>
  resolveRegisteredRoute: (method: string, pathname: string) => ActorRef<HttpRequestMsg> | undefined
  getConfigSchemas: () => any[]
  
  // Connection and message callbacks
  onConnect: (client: WsData) => void
  onDisconnect: (clientId: string) => void
  onMessage: (clientId: string, userId: string, text: string, attachments?: MessageAttachment[]) => void
  onWsFrame?: (clientId: string, userId: string, roles: string[], frame: any) => void
  onConfigUpdate: (pluginId: string, patch: Record<string, unknown>) => void
  uploadMedia: (key: string, stream: ReadableStream<Uint8Array>, contentType: string) => Promise<{ ok: true } | { ok: false; error: string }>
  fetchMedia: (key: string) => Promise<{ stream: ReadableStream<Uint8Array>; mimeType: string } | null>
};

export const startServer = (options: ServerOptions): Server<WsData> => {
  const {
    port,
    PUBLIC_DIR,
    MEDIA_DIR,
    resolveIdentity,
    resolveCookieIdentity,
    authorizeConfigAccess,
    resolveRegisteredRoute,
    getConfigSchemas,
    onConnect,
    onDisconnect,
    onMessage,
    onWsFrame,
    onConfigUpdate,
  } = options

  const CHANNEL = 'broadcast'
  const ADMIN_CHANNEL = 'admin:broadcast'

  return Bun.serve<WsData>({
    port,

    async fetch(req, server) {
      const url = new URL(req.url)

      // 1. WebSocket upgrade
      if (url.pathname === '/ws') {
        const ticket = url.searchParams.get('ticket') ?? ''
        const session = await resolveIdentity(ticket)
        if (!session) return new Response('Unauthorized', { status: 401 })
        const clientId = crypto.randomUUID()
        const upgraded = server.upgrade(req, { data: { clientId, userId: session.userId, roles: session.roles } })
        if (!upgraded) return new Response('WebSocket upgrade failed', { status: 400 })
        return undefined as unknown as Response
      }

      // 2. Authorization for configuration / knowledge graph APIs
      const isConfig = url.pathname === '/config/schema' || url.pathname.startsWith('/config/')
      if (isConfig) {
        const identity = await resolveCookieIdentity(req)
        const denied = await authorizeConfigAccess(req, url, identity, {
          requireSameOrigin: req.method !== 'GET',
        })
        if (denied) return denied
      }

      // 3. Plugin-registered routes (auth, etc.) win over inline handlers.
      const targetActor = resolveRegisteredRoute(req.method, url.pathname)
      if (targetActor) {
        const identity = await resolveCookieIdentity(req)
        
        const headers: Record<string, string> = {}
        req.headers.forEach((value, key) => {
          headers[key] = value
        })

        let body: string | null = null
        if (req.body) {
          body = await req.text()
        }

        try {
          const resMsg = await ask<HttpRequestMsg, HttpResponseMsg>(
            targetActor,
            replyTo => ({
              type: 'http.request',
              request: {
                method: req.method,
                url: url.pathname + url.search,
                headers,
                body,
              },
              identity,
              replyTo,
            }),
            { timeoutMs: 30_000 }
          )

          return new Response(resMsg.response.body as any, {
            status: resMsg.response.status,
            headers: resMsg.response.headers,
          })
        } catch (err) {
          return new Response(JSON.stringify({ error: `Gateway Timeout: ${String(err)}` }), {
            status: 504,
            headers: { 'Content-Type': 'application/json' },
          })
        }
      }

      // 4. Current user identity
      if (req.method === 'GET' && url.pathname === '/me') {
        const identity = await resolveCookieIdentity(req)
        return new Response(JSON.stringify({ userId: identity?.userId ?? null, roles: identity?.roles ?? [] }), { headers: { 'Content-Type': 'application/json' } })
      }

      // 6. Config schema API (authorized above)
      if (req.method === 'GET' && url.pathname === '/config/schema') {
        return new Response(JSON.stringify(getConfigSchemas()), {
          headers: { 'Content-Type': 'application/json' },
        })
      }

      // 7. Per-plugin config update (authorized above)
      if (req.method === 'POST' && url.pathname.startsWith('/config/')) {
        const pluginId = url.pathname.slice('/config/'.length)
        if (pluginId && !pluginId.includes('/')) {
          try {
            const patch = await req.json()
            onConfigUpdate(pluginId, patch)
            return new Response(null, { status: 204 })
          } catch {
            return new Response('Invalid JSON', { status: 400 })
          }
        }
      }

      // Stream Upload Endpoint
      if (req.method === 'POST' && url.pathname.startsWith('/upload/media/')) {
        const identity = await resolveCookieIdentity(req)
        if (!identity) {
          return new Response('Unauthorized', { status: 401 })
        }

        const rawName = url.pathname.slice('/upload/media/'.length)
        const decodedName = decodeURIComponent(rawName)
        const baseName = decodedName.split('/').pop() || 'file'
        const ext = baseName.split('.').pop() || 'bin'
        const key = `inbound/rorschach-${crypto.randomUUID()}.${ext}`

        const stream = req.body
        if (!stream) {
          return new Response('Bad Request: Empty Body', { status: 400 })
        }
        const uploaded = await options.uploadMedia(key, stream, req.headers.get('Content-Type') || 'application/octet-stream')
        if (uploaded.ok) {
          return new Response(JSON.stringify({ url: key }), {
            headers: { 'Content-Type': 'application/json' }
          })
        } else {
          return new Response(uploaded.error || 'Upload failed', { status: 500 })
        }
      }

      // 8. Serving media from Object Store or static files
      const isMedia = url.pathname.startsWith('/inbound/') || url.pathname.startsWith('/generated/')
      if (isMedia) {
        const key = url.pathname.slice(1) // e.g. "inbound/rorschach-XYZ..."
        const media = await options.fetchMedia(key)
        if (media) {
          return new Response(media.stream, {
            headers: { 'Content-Type': media.mimeType }
          })
        }
        return new Response('Not Found', { status: 404 })
      }

      // 9. Static file serving (excluding media files)
      const filePath = url.pathname === '/'
        ? join(PUBLIC_DIR, 'index.html')
        : safeJoinUrlPath(PUBLIC_DIR, url.pathname)

      if (!filePath) return new Response('Not Found', { status: 404 })

      const file = Bun.file(filePath)
      if (await file.exists()) {
        return new Response(file, {
          headers: { 'Content-Type': mimeType(filePath) },
        })
      }

      return new Response('Not Found', { status: 404 })
    },

    websocket: {
      open: (ws: ServerWebSocket<WsData>) => {
        ws.subscribe(CHANNEL)
        const isAdmin = options.checkAdmin(ws.data.roles)
        if (isAdmin) {
          ws.subscribe(ADMIN_CHANNEL)
        }
        ws.subscribe(`client:${ws.data.clientId}`)
        onConnect(ws.data)
      },
      message: (ws: ServerWebSocket<WsData>, message) => {
        const raw = typeof message === 'string' ? message : message.toString()
        let text = raw
        let attachments: MessageAttachment[] | undefined
        try {
          const parsed = JSON.parse(raw)
          if (typeof parsed.type === 'string') {
            onWsFrame?.(ws.data.clientId, ws.data.userId, ws.data.roles, parsed)
            return
          }
          if (typeof parsed.text === 'string') {
            text = parsed.text
            attachments = parsed.attachments
          }
        } catch { /* plain text */ }
        onMessage(ws.data.clientId, ws.data.userId, text, attachments)
      },
      close: (ws: ServerWebSocket<WsData>) => {
        ws.unsubscribe(CHANNEL)
        ws.unsubscribe(ADMIN_CHANNEL)
        onDisconnect(ws.data.clientId)
      },
    },
  })
}
