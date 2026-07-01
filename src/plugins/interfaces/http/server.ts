import { join } from 'node:path'
import type { Server, ServerWebSocket } from 'bun'
import { mimeType, safeJoinUrlPath } from './media.ts'
import type { MessageAttachment } from '../../../types/events.ts'
import type { Identity } from '../../../types/identity.ts'

export type WsData = { clientId: string; userId: string; roles: string[] }

export type ServerOptions = {
  port: number
  PUBLIC_DIR: string
  MEDIA_DIR: string
  checkAdmin: (roles: readonly string[]) => boolean
  resolveIdentity: (ticket: string) => Promise<Identity | null>
  resolveCookieIdentity: (req: Request) => Promise<Identity | null>
  authorizeConfigAccess: (req: Request, url: URL, identity: Identity | null, options?: { requireSameOrigin?: boolean }) => Promise<Response | null>
  resolveRegisteredRoute: (method: string, pathname: string) => Function | undefined
  fetchModels: () => Promise<string[]>
  getConfigSchemas: () => any[]
  
  // Connection and message callbacks
  onConnect: (client: WsData) => void
  onDisconnect: (clientId: string) => void
  onMessage: (clientId: string, userId: string, text: string, attachments?: MessageAttachment[]) => void
  onWsFrame?: (clientId: string, userId: string, roles: string[], frame: any) => void
  onConfigUpdate: (pluginId: string, patch: Record<string, unknown>) => void
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
    fetchModels,
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
      const isConfig = url.pathname === '/config/schema' || url.pathname.startsWith('/config/') || url.pathname === '/kgraph'
      if (isConfig) {
        const identity = await resolveCookieIdentity(req)
        const denied = await authorizeConfigAccess(req, url, identity, {
          requireSameOrigin: req.method !== 'GET',
        })
        if (denied) return denied
      }

      // 3. Plugin-registered routes (auth, etc.) win over inline handlers.
      const registered = resolveRegisteredRoute(req.method, url.pathname)
      if (registered) {
        const identity = await resolveCookieIdentity(req)
        return await registered(req, url, identity)
      }

      // 4. Models API
      if (req.method === 'GET' && url.pathname === '/models') {
        try {
          const models = await fetchModels()
          return new Response(JSON.stringify(models), { headers: { 'Content-Type': 'application/json' } })
        } catch {
          return new Response('[]', { headers: { 'Content-Type': 'application/json' } })
        }
      }

      // 5. Current user identity
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

      // 8. Static file serving (including media files)
      const isMedia = url.pathname.startsWith('/inbound/') || url.pathname.startsWith('/generated/')
      const filePath = url.pathname === '/'
        ? join(PUBLIC_DIR, 'index.html')
        : isMedia
          ? safeJoinUrlPath(MEDIA_DIR, url.pathname)
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
