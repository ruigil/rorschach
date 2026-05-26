import { join, resolve, sep } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { Server, ServerWebSocket } from 'bun'
import { emit } from '../../system/index.ts'
import {
  InboundMessageTopic,
  ClientPresenceTopic,
  OutboundMessageTopic, OutboundBroadcastTopic, OutboundAdminBroadcastTopic,
  type MessageAttachment,
} from '../../types/events.ts'
import type { ActorDef, ActorRef, SpanHandle } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { ask } from '../../system/index.ts'
import { LlmProviderTopic, CostTopic } from '../../types/llm.ts'
import type { LlmProviderMsg, CostEvent } from '../../types/llm.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import type { RouteRegistration } from '../../types/routes.ts'
import { ConfigSchemaTopic, ConfigUpdateRequestTopic } from '../../types/config.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import { IdentityProviderTopic, type Identity } from '../../types/identity.ts'
import { resolveIdentity, resolveCookieIdentity } from './types.ts'
import type { IdentityProviderMsg } from '../../types/identity.ts'
import { AgentCatalogTopic, SwitchAgentTopic, type AgentCatalogEvent } from '../../types/agents.ts'

// ─── Public directory (resolved relative to this module) ───
const PUBLIC_DIR = join(import.meta.dir, '../..', 'public')
const MEDIA_DIR = join(import.meta.dir, '../../..', 'workspace/media')
const INBOUND_DIR = join(MEDIA_DIR, 'inbound')

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
  | { type: 'connected'; clientId: string; userId: string; roles: string[] }
  | { type: 'message'; clientId: string; text: string; attachments?: MessageAttachment[] }
  | { type: 'switchMode'; clientId: string; mode: string }
  | { type: 'listAgents'; clientId: string }
  | { type: '_mediaSaved'; clientId: string; text: string; attachments: MessageAttachment[] }
  | { type: 'closed'; clientId: string }
  | { type: 'broadcast'; text: string }
  | { type: 'adminBroadcast'; text: string }
  | { type: 'send'; clientId: string; text: string }
  | { type: '_configSchemaChanged'; section: ConfigSchemaSection }
  | { type: '_configUpdate'; pluginId: string; patch: Record<string, unknown> }
  | { type: '_llmProviderChanged'; ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_identityProviderChanged'; ref: ActorRef<IdentityProviderMsg> | null }
  | { type: '_routeChanged'; reg: RouteRegistration }
  | { type: '_agentCatalog'; agents: AgentCatalogEvent['agents'] }
  | { type: '_imageGenerated'; publicUrl: string }
  | { type: '_audioGenerated'; publicUrl: string }
  | { type: '_cost'; event: CostEvent }

// ─── Media helpers ───

const saveAttachmentsToTempFiles = (attachments: MessageAttachment[]): Promise<MessageAttachment[]> =>
  Promise.all(attachments.map(async (att) => {
    if (!att.data) return att

    const match = att.data.match(/^data:[^;]+;base64,(.+)$/)
    const b64 = match?.[1] ?? att.data
    const ext = att.mimeType?.split('/')[1] || att.name?.split('.').pop() || (att.kind === 'image' ? 'jpeg' : att.kind === 'audio' ? 'wav' : 'bin')
    const fileName = att.name ? `rorschach-${crypto.randomUUID()}-${att.name}` : `rorschach-${crypto.randomUUID()}.${ext}`
    const filePath = join(INBOUND_DIR, fileName)

    await mkdir(INBOUND_DIR, { recursive: true })
    await Bun.write(filePath, Buffer.from(b64, 'base64'))

    return { ...att, url: filePath, data: undefined }
  }))

// ─── Actor state ───

export type HttpState = {
  server:              Server<WsData> | null
  connections:         number
  activeSpans:         Record<string, SpanHandle>
  llmProviderRef:      ActorRef<LlmProviderMsg>      | null
  identityProviderRef: ActorRef<IdentityProviderMsg> | null
  agentCatalog:        AgentCatalogEvent['agents']
}

// ─── WebSocket attachment data ───

type WsData = { clientId: string; userId: string; roles: string[] }

// ─── Options ───

export type HTTPOptions = {
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
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
  if (path.endsWith('.gif')) return 'image/gif'
  if (path.endsWith('.webp')) return 'image/webp'
  if (path.endsWith('.pdf')) return 'application/pdf'
  return 'application/octet-stream'
}

const safeJoinUrlPath = (baseDir: string, pathname: string): string | null => {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }

  const base = resolve(baseDir)
  const filePath = resolve(base, `.${decoded}`)
  return filePath === base || filePath.startsWith(base + sep) ? filePath : null
}

const hasAdminRole = (roles: readonly string[]): boolean =>
  roles.includes('admin')

export const canAccessAdminSurface = (
  identityProviderRef: ActorRef<IdentityProviderMsg> | null,
  roles: readonly string[],
): boolean =>
  identityProviderRef === null || hasAdminRole(roles)

const isSameOriginRequest = (req: Request, url: URL): boolean => {
  const origin = req.headers.get('origin')
  if (!origin) return true
  const allowedOrigins = new Set([url.origin])

  const addHostOrigins = (host: string | undefined | null, proto?: string | null) => {
    const normalizedHost = host?.split(',')[0]?.trim()
    if (!normalizedHost) return
    const schemes = proto ? [proto] : [url.protocol.slice(0, -1), 'https']
    for (const scheme of schemes) {
      try {
        allowedOrigins.add(new URL(`${scheme}://${normalizedHost}`).origin)
      } catch { /* ignore malformed host headers */ }
    }
  }

  addHostOrigins(req.headers.get('host'))

  const forwardedHost = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  addHostOrigins(forwardedHost, forwardedProto)

  const forwarded = req.headers.get('forwarded')?.split(',')[0]
  if (forwarded) {
    const parts = Object.fromEntries(
      forwarded.split(';').map(part => {
        const [key, value] = part.split('=')
        return [key?.trim().toLowerCase(), value?.trim().replace(/^"|"$/g, '')]
      }).filter(([key, value]) => key && value),
    )
    if (parts.host && parts.proto) {
      addHostOrigins(parts.host, parts.proto)
    }
  }

  try {
    return allowedOrigins.has(new URL(origin).origin)
  } catch {
    return false
  }
}

export const authorizeConfigAccess = async (
  identityProviderRef: ActorRef<IdentityProviderMsg> | null,
  req: Request,
  url: URL,
  identity: Identity | null,
  options?: { requireSameOrigin?: boolean },
): Promise<Response | null> => {
  if (options?.requireSameOrigin && !isSameOriginRequest(req, url)) {
    return new Response('Forbidden', { status: 403 })
  }

  if (!identity) return new Response('Unauthorized', { status: 401 })
  if (!canAccessAdminSurface(identityProviderRef, identity.roles)) return new Response('Forbidden', { status: 403 })
  return null
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
export const HTTP = (
  options?: HTTPOptions,
): ActorDef<HttpMessage, HttpState> => {
  const port = options?.port ?? 3000
  const CHANNEL = 'broadcast'
  const ADMIN_CHANNEL = 'admin:broadcast'

  // Mutable refs captured by Bun's server callbacks (which run outside the actor message loop)
  let selfRef:             ActorRef<HttpMessage>         | null = null
  let llmProviderRef:      ActorRef<LlmProviderMsg>      | null = null
  let identityProviderRef: ActorRef<IdentityProviderMsg> | null = null
  const configSchemas = new Map<string, ConfigSchemaSection>()
  type RouteHandler = Extract<RouteRegistration, { handler: Function }>['handler']
  type RouteMatch = NonNullable<RouteRegistration['match']>
  type RouteRecord = { method: string; path: string; match: RouteMatch; handler: RouteHandler }

  const routes = new Map<string, RouteRecord>()
  const routeKey = (method: string, path: string, match: RouteMatch = 'exact') => `${method.toUpperCase()} ${match} ${path}`

  const resolveRegisteredRoute = (method: string, pathname: string): RouteHandler | undefined => {
    const upperMethod = method.toUpperCase()
    const exact = routes.get(routeKey(upperMethod, pathname, 'exact'))
    if (exact) return exact.handler

    let best: RouteRecord | undefined
    for (const route of routes.values()) {
      if (route.method !== upperMethod || route.match !== 'prefix') continue
      if (!pathname.startsWith(route.path)) continue
      if (!best || route.path.length > best.path.length) best = route
    }
    return best?.handler
  }

  return {
    initialState: { server: null, connections: 0, activeSpans: {}, llmProviderRef: null, identityProviderRef: null, agentCatalog: [] },
    handler: onMessage({

      connected: (state, message, context) => {
        const connections = state.connections + 1
        context.log.info(`client connected: ${message.clientId} userId=${message.userId} (${connections} total)`)
        context.publishRetained(ClientPresenceTopic, message.clientId, {
          status: 'connected',
          clientId: message.clientId,
          userId:   message.userId,
          roles:    message.roles,
        })
        // Push the agent catalog as a welcome frame so the UI can render its mode selector.
        if (state.agentCatalog.length > 0) {
          state.server?.publish(`client:${message.clientId}`, JSON.stringify({ type: 'agents', agents: state.agentCatalog }))
        }
        return {
          state: { ...state, connections },
        }
      },

      switchMode: (state, message, context) => {
        context.log.info(`switchMode: clientId=${message.clientId} mode=${message.mode}`)
        return {
          state,
          events: [emit(SwitchAgentTopic, { clientId: message.clientId, mode: message.mode, source: 'user' })],
        }
      },

      listAgents: (state, message) => {
        state.server?.publish(`client:${message.clientId}`, JSON.stringify({ type: 'agents', agents: state.agentCatalog }))
        return { state }
      },

      _agentCatalog: (state, message) => {
        // Push to all already-connected clients on every catalog change.
        state.server?.publish(CHANNEL, JSON.stringify({ type: 'agents', agents: message.agents }))
        return { state: { ...state, agentCatalog: message.agents } }
      },

      message: (state, message, context) => {
        context.log.debug(`[${message.clientId}] ${message.text}`)
        const span = context.trace.start('request', { clientId: message.clientId })
        const newState = { ...state, activeSpans: { ...state.activeSpans, [message.clientId]: span } }

        if (message.attachments && message.attachments.length > 0) {
          context.pipeToSelf(
            saveAttachmentsToTempFiles(message.attachments),
            (attachments): HttpMessage => ({ type: '_mediaSaved', clientId: message.clientId, text: message.text, attachments }),
            (): HttpMessage => ({ type: '_mediaSaved', clientId: message.clientId, text: message.text, attachments: [] }),
          )
          return { state: newState }
        }

        return {
          state: newState,
          events: [emit(InboundMessageTopic, {
            clientId: message.clientId,
            text: message.text,
            traceId: span.traceId,
            parentSpanId: span.spanId,
          })],
        }
      },

      _mediaSaved: (state, message) => {
        const { clientId, text, attachments } = message
        const span = state.activeSpans[clientId]
        if (!span) return { state }
        return {
          state,
          events: [emit(InboundMessageTopic, {
            clientId,
            text,
            attachments: attachments.length > 0 ? attachments : undefined,
            traceId: span.traceId,
            parentSpanId: span.spanId,
          })],
        }
      },

      closed: (state, message, context) => {
        const connections = Math.max(0, state.connections - 1)
        context.log.info(`client disconnected: ${message.clientId} (${connections} remaining)`)
        context.deleteRetained(ClientPresenceTopic, message.clientId, {
          status:   'disconnected',
          clientId: message.clientId,
        })
        const span = state.activeSpans[message.clientId]
        if (span) {
          span.error('client disconnected')
          const { [message.clientId]: _, ...rest } = state.activeSpans
          return {
            state: { ...state, connections, activeSpans: rest },
          }
        }
        return {
          state: { ...state, connections },
        }
      },

      broadcast: (state, message) => {
        state.server?.publish(CHANNEL, message.text)
        return { state }
      },

      adminBroadcast: (state, message) => {
        state.server?.publish(ADMIN_CHANNEL, message.text)
        return { state }
      },

      _cost: (state, message) => {
        const { event } = message
        const text = JSON.stringify({
          type:         'usage',
          role:         event.role,
          model:        event.model,
          inputTokens:  event.inputTokens,
          outputTokens: event.outputTokens,
          cost:         event.cost,
        })
        state.server?.publish(ADMIN_CHANNEL, text)
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

      _configSchemaChanged: (state, message) => {
        if (message.section.schema === null) {
          configSchemas.delete(message.section.id)
        } else {
          configSchemas.set(message.section.id, message.section)
        }
        return { state }
      },

      _configUpdate: (state, message, context) => {
        context.publish(ConfigUpdateRequestTopic, {
          pluginId: message.pluginId,
          patch: message.patch,
        })
        return { state }
      },

      _llmProviderChanged: (state, message) => {
        llmProviderRef = message.ref
        return { state: { ...state, llmProviderRef: message.ref } }
      },

      _identityProviderChanged: (state, message) => {
        identityProviderRef = message.ref
        return { state: { ...state, identityProviderRef: message.ref } }
      },

      _routeChanged: (state, message) => {
        const { reg } = message
        const match = reg.match ?? 'exact'
        const method = reg.method.toUpperCase()
        const key = routeKey(method, reg.path, match)
        if (reg.handler === null) routes.delete(key)
        else routes.set(key, { method, path: reg.path, match, handler: reg.handler })
        return { state }
      },


    }),

    lifecycle: onLifecycle({
      start: (state, context) => {
        selfRef = context.self

        context.subscribe(OutboundMessageTopic, (e) => ({
          type: 'send' as const,
          clientId: e.clientId,
          text: e.text,
        }))

        context.subscribe(OutboundBroadcastTopic, (e) => ({
          type: 'broadcast' as const,
          text: e.text,
        }))

        context.subscribe(OutboundAdminBroadcastTopic, (e) => ({
          type: 'adminBroadcast' as const,
          text: e.text,
        }))

        context.subscribe(CostTopic, (event) => ({
          type: '_cost' as const,
          event,
        }))

        context.subscribe(LlmProviderTopic, (e) => ({
          type: '_llmProviderChanged' as const,
          ref: e.ref,
        }))

        context.subscribe(ConfigSchemaTopic, (section) => ({
          type: '_configSchemaChanged' as const,
          section,
        }))

        context.subscribe(IdentityProviderTopic, (e) => ({
          type: '_identityProviderChanged' as const,
          ref: e.ref,
        }))

        context.subscribe(RouteRegistrationTopic, (reg) => ({
          type: '_routeChanged' as const,
          reg,
        }))

        context.subscribe(AgentCatalogTopic, (e) => ({
          type: '_agentCatalog' as const,
          agents: e.agents,
        }))


        const server = Bun.serve<WsData>({
          port,

          // ─── HTTP handler: static file serving ───
          async fetch(req, server) {
            const url = new URL(req.url)

            // Resolve identity once at the boundary for all non-static requests.
            // WebSocket upgrade handles its own resolution via ticket.
            const isMedia = url.pathname.startsWith('/inbound/') || url.pathname.startsWith('/generated/')
            // Plugin-served paths (e.g. /artifacts/*) must not be treated as static even if they
            // end in .html — the registered route handler does its own auth check using identity.
            const isPluginPath = url.pathname.startsWith('/artifacts/')
            const isStatic = !isPluginPath && (url.pathname === '/' || url.pathname.endsWith('.html') || url.pathname.endsWith('.css') || url.pathname.endsWith('.js') || url.pathname.endsWith('.ico'))
            const identity = (!isMedia && !isStatic && url.pathname !== '/ws')
              ? await resolveCookieIdentity(identityProviderRef, req)
              : null

            if (url.pathname === '/config/schema' || url.pathname.startsWith('/config/') || url.pathname === '/kgraph') {
              const denied = await authorizeConfigAccess(identityProviderRef, req, url, identity, {
                requireSameOrigin: req.method !== 'GET',
              })
              if (denied) return denied
            }

            // Plugin-registered routes (auth, etc.) win over inline handlers.
            const registered = resolveRegisteredRoute(req.method, url.pathname)
            if (registered) return await registered(req, url, identity)

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

            // Current user identity
            if (req.method === 'GET' && url.pathname === '/me') {
              return new Response(JSON.stringify({ userId: identity?.userId ?? null, roles: identity?.roles ?? [] }), { headers: { 'Content-Type': 'application/json' } })
            }

            // Config schema API
            if (req.method === 'GET' && url.pathname === '/config/schema') {
              return new Response(JSON.stringify([...configSchemas.values()]), {
                headers: { 'Content-Type': 'application/json' },
              })
            }

            // Per-plugin config update
            if (req.method === 'POST' && url.pathname.startsWith('/config/')) {
              const pluginId = url.pathname.slice('/config/'.length)
              if (pluginId && !pluginId.includes('/')) {
                try {
                  const patch = await req.json()
                  selfRef?.send({ type: '_configUpdate', pluginId, patch })
                  return new Response(null, { status: 204 })
                } catch {
                  return new Response('Invalid JSON', { status: 400 })
                }
              }
            }

            // ─── WebSocket upgrade ───
            // Auth-loaded + invalid ticket ⇒ 401 (frontend redirects to login).
            // No provider                  ⇒ ANONYMOUS_IDENTITY (open access).
            if (url.pathname === '/ws') {
              const ticket = url.searchParams.get('ticket') ?? ''
              const session = await resolveIdentity(identityProviderRef,
                r => ({ type: 'resolveTicket', ticket, replyTo: r }))
              if (!session) return new Response('Unauthorized', { status: 401 })
              const clientId = crypto.randomUUID()
              const upgraded = server.upgrade(req, { data: { clientId, userId: session.userId, roles: session.roles } })
              if (!upgraded) return new Response('WebSocket upgrade failed', { status: 400 })
              return undefined as unknown as Response
            }

            // Static file serving
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

          // ─── WebSocket handlers ───
          websocket: {
            open: (ws: ServerWebSocket<WsData>) => {
              ws.subscribe(CHANNEL)
              if (canAccessAdminSurface(identityProviderRef, ws.data.roles)) {
                ws.subscribe(ADMIN_CHANNEL)
              }
              ws.subscribe(`client:${ws.data.clientId}`)
              selfRef?.send({ type: 'connected', clientId: ws.data.clientId, userId: ws.data.userId, roles: ws.data.roles })
            },
            message: (ws: ServerWebSocket<WsData>, message) => {
              const raw = typeof message === 'string' ? message : message.toString()
              let text = raw
              let attachments: MessageAttachment[] | undefined
              try {
                const parsed = JSON.parse(raw) as {
                  type?:        string
                  mode?:        string
                  text?:        string
                  attachments?: MessageAttachment[]
                }
                // Control frames (switchMode, listAgents) — handled separately from chat messages.
                if (parsed.type === 'switchMode' && typeof parsed.mode === 'string') {
                  selfRef?.send({ type: 'switchMode', clientId: ws.data.clientId, mode: parsed.mode })
                  return
                }
                if (parsed.type === 'listAgents') {
                  selfRef?.send({ type: 'listAgents', clientId: ws.data.clientId })
                  return
                }
                if (typeof parsed.text === 'string') {
                  text = parsed.text
                  attachments = parsed.attachments
                }
              } catch { /* plain text */ }
              selfRef?.send({ type: 'message', clientId: ws.data.clientId, text, attachments })
            },
            close: (ws: ServerWebSocket<WsData>) => {
              ws.unsubscribe(CHANNEL)
              ws.unsubscribe(ADMIN_CHANNEL)
              selfRef?.send({ type: 'closed', clientId: ws.data.clientId })
            },
          },
        })

        context.log.info(`listening on http://localhost:${server.port}`)
        console.log(`🌍 listening on http://localhost:${server.port}`)
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
