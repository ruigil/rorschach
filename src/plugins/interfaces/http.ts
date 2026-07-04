import { join } from 'node:path'
import type { Server } from 'bun'
import { emit } from '../../system/index.ts'
import {
  InboundMessageTopic,
  UserPresenceTopic,
  OutboundUserMessageTopic, OutboundAdminBroadcastTopic,
  HttpWsFrameTopic,
  type MessageAttachment,
} from '../../types/events.ts'
import type { ActorDef, ActorRef, SpanHandle } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { ask } from '../../system/index.ts'
import { LlmProviderTopic, CostTopic } from '../../types/llm.ts'
import type { LlmProviderMsg, CostEvent } from '../../types/llm.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import type { RouteRegistration } from '../../types/routes.ts'
import { UiSurfaceRegistrationTopic } from '../../types/ui-surface.ts'
import type { UiSurfaceRegistration } from '../../types/ui-surface.ts'
import { ConfigSchemaTopic, ConfigUpdateRequestTopic } from '../../types/config.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import { IdentityProviderTopic, type Identity } from '../../types/identity.ts'
import { resolveIdentity, resolveCookieIdentity } from './types.ts'
import type { IdentityProviderMsg } from '../../types/identity.ts'
import { AgentCatalogTopic, SwitchAgentTopic, type AgentCatalogEvent } from '../../types/agents.ts'
import { ToolRegistrationTopic } from '../../types/tools.ts'
import type { ToolRegistrationEvent } from '../../types/tools.ts'

import { canAccessAdminSurface, authorizeConfigAccess } from './http/security.ts'
import { saveAttachmentsToTempFiles } from './http/media.ts'
import { startServer, type WsData } from './http/server.ts'

// Re-export helpers imported by other files (e.g. tests)
export { canAccessAdminSurface, authorizeConfigAccess }

// ─── Public directory (build output served by the HTTP handler) ───
const PUBLIC_DIR = join(process.cwd(), 'src', 'frontend', 'static')
const MEDIA_DIR = join(import.meta.dir, '../../..', 'workspace/media')


// ─── Message protocol ───

export type HttpMessage =
  | { type: 'connected'; clientId: string; userId: string; roles: string[] }
  | { type: 'message'; clientId: string; userId: string; text: string; attachments?: MessageAttachment[] }
  | { type: '_wsFrame'; clientId: string; userId: string; roles: string[]; frame: any }
  | { type: '_mediaSaved'; clientId: string; userId: string; text: string; attachments: MessageAttachment[] }
  | { type: 'closed'; clientId: string }
  | { type: 'adminBroadcast'; text: string }
  | { type: 'send'; userId: string; text: string }
  | { type: '_configSchemaChanged'; section: ConfigSchemaSection }
  | { type: '_toolRegistration'; event: ToolRegistrationEvent }
  | { type: '_configUpdate'; pluginId: string; patch: Record<string, unknown> }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_identityProviderChanged'; ref: ActorRef<IdentityProviderMsg> | null }
  | { type: '_routeChanged'; reg: RouteRegistration }
  | { type: '_uiSurfaceChanged'; reg: UiSurfaceRegistration }
  | { type: '_agentCatalog'; agents: AgentCatalogEvent['agents'] }
  | { type: '_imageGenerated'; publicUrl: string }
  | { type: '_audioGenerated'; publicUrl: string }
  | { type: '_cost'; event: CostEvent }

// ─── Actor state ───

export type HttpState = {
  server:              Server<WsData> | null
  connections:         number
  activeSpans:         Record<string, SpanHandle>
  llmProviderRef:      ActorRef<LlmProviderMsg>      | null
  identityProviderRef: ActorRef<IdentityProviderMsg> | null
  agentCatalog:        AgentCatalogEvent['agents']
  userIdsToClientIds:  Record<string, string[]>
  surfaces:             Record<string, UiSurfaceRegistration>
  toolsSnapshot:       Record<string, Extract<ToolRegistrationEvent, { schema: unknown }>>
}

// ─── Options ───

export type HTTPOptions = {
  port?: number
}

const findUserIdByClientId = (userIdsToClientIds: Record<string, string[]>, clientId: string): string => {
  for (const [userId, clientIds] of Object.entries(userIdsToClientIds)) {
    if (clientIds.includes(clientId)) return userId
  }
  return ''
}

/**
 * Creates an HTTP + WebSocket actor definition.
 */
export const HTTP = ( options?: HTTPOptions ): ActorDef<HttpMessage, HttpState> => {
  const port = options?.port ?? 3000
  const CHANNEL = 'broadcast'
  const ADMIN_CHANNEL = 'admin:broadcast'

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
    initialState: { server: null, connections: 0, activeSpans: {}, llmProviderRef: null, identityProviderRef: null, agentCatalog: [], userIdsToClientIds: {}, surfaces: {}, toolsSnapshot: {} },
    handler: onMessage({

      connected: (state, message, context) => {
        const connections = state.connections + 1
        context.log.info(`client connected: ${message.clientId} userId=${message.userId} (${connections} total)`)
        
        const currentClientIds = state.userIdsToClientIds[message.userId] ?? []
        const userIdsToClientIds = {
          ...state.userIdsToClientIds,
          [message.userId]: [...currentClientIds, message.clientId]
        }

        const events = []
        if (currentClientIds.length === 0) {
          events.push(emit(UserPresenceTopic, {
            status: 'present',
            userId: message.userId,
            source: 'http',
          }))
        }

        if (state.agentCatalog.length > 0) {
          state.server?.publish(`client:${message.clientId}`, JSON.stringify({ type: 'agents', agents: state.agentCatalog }))
        }
        for (const reg of Object.values(state.surfaces)) {
          state.server?.publish(`client:${message.clientId}`, JSON.stringify({ type: 'ui.surface', reg }))
        }
        for (const toolEvent of Object.values(state.toolsSnapshot)) {
          state.server?.publish(`client:${message.clientId}`, JSON.stringify({ type: 'tool_registered', name: toolEvent.name, schema: toolEvent.schema }))
        }
        return {
          state: { ...state, connections, userIdsToClientIds },
          events,
        }
      },

      _toolRegistration: (state, message) => {
        const { event } = message
        const toolsSnapshot = { ...state.toolsSnapshot }
        if (event.ref === null) {
          delete toolsSnapshot[event.name]
          state.server?.publish(ADMIN_CHANNEL, JSON.stringify({ type: 'tool_unregistered', name: event.name }))
        } else {
          toolsSnapshot[event.name] = event
          state.server?.publish(ADMIN_CHANNEL, JSON.stringify({ type: 'tool_registered', name: event.name, schema: event.schema }))
        }
        return { state: { ...state, toolsSnapshot } }
      },

      _wsFrame: (state, message, context) => {
        return {
          state,
          events: [
            emit(HttpWsFrameTopic, {
              clientId: message.clientId,
              userId: message.userId,
              roles: message.roles,
              frame: message.frame,
            })
          ],
        }
      },

      _agentCatalog: (state, message) => {
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
            (attachments): HttpMessage => ({ type: '_mediaSaved', clientId: message.clientId, userId: message.userId, text: message.text, attachments }),
            (): HttpMessage => ({ type: '_mediaSaved', clientId: message.clientId, userId: message.userId, text: message.text, attachments: [] }),
          )
          return { state: newState }
        }

        return {
          state: newState,
          events: [emit(InboundMessageTopic, {
            userId: message.userId,
            text: message.text,
            traceId: span.traceId,
            parentSpanId: span.spanId,
          })],
        }
      },

      _mediaSaved: (state, message) => {
        const { clientId, userId, text, attachments } = message
        const span = state.activeSpans[clientId]
        if (!span) return { state }
        return {
          state,
          events: [emit(InboundMessageTopic, {
            userId,
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

        const userId = findUserIdByClientId(state.userIdsToClientIds, message.clientId)
        const nextUserIdsToClientIds = { ...state.userIdsToClientIds }
        const clientIds = userId ? nextUserIdsToClientIds[userId] : undefined
        if (clientIds) {
          const filtered = clientIds.filter(id => id !== message.clientId)
          if (filtered.length === 0) {
            delete nextUserIdsToClientIds[userId]
          } else {
            nextUserIdsToClientIds[userId] = filtered
          }
        }

        const events = []
        const uClientIds = nextUserIdsToClientIds[userId]
        if (userId && (!uClientIds || uClientIds.length === 0)) {
          events.push(emit(UserPresenceTopic, {
            status: 'absent',
            userId,
            source: 'http',
          }))
        }

        const span = state.activeSpans[message.clientId]
        const activeSpans = { ...state.activeSpans }
        if (span) {
          span.error('client disconnected')
          delete activeSpans[message.clientId]
        }
        return {
          state: { ...state, connections, activeSpans, userIdsToClientIds: nextUserIdsToClientIds },
          events,
        }
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
        const clientIds = state.userIdsToClientIds[message.userId] ?? []
        const activeSpans = { ...state.activeSpans }
        let changed = false
        for (const clientId of clientIds) {
          state.server?.publish(`client:${clientId}`, message.text)
          try {
            const parsed = JSON.parse(message.text)
            if (parsed.type === 'done' || parsed.type === 'error') {
              const span = activeSpans[clientId]
              if (span) {
                parsed.type === 'done' ? span.done() : span.error()
                delete activeSpans[clientId]
                changed = true
              }
            }
          } catch { /* non-JSON text */ }
        }
        return changed ? { state: { ...state, activeSpans } } : { state }
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

      _llmProvider: (state, message) => {
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

      _uiSurfaceChanged: (state, message) => {
        const { reg } = message
        const surfaces = { ...state.surfaces }
        if (reg.moduleUrl === null) delete surfaces[reg.id]
        else surfaces[reg.id] = reg
        state.server?.publish(CHANNEL, JSON.stringify({ type: 'ui.surface', reg }))
        return { state: { ...state, surfaces } }
      },

    }),

    lifecycle: onLifecycle({
      start: (state, context) => {
        selfRef = context.self

        context.subscribe(OutboundUserMessageTopic, (e) => ({
          type: 'send' as const,
          userId: e.userId,
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
          type: '_llmProvider' as const,
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

        context.subscribe(UiSurfaceRegistrationTopic, (reg) => ({
          type: '_uiSurfaceChanged' as const,
          reg,
        }))

        context.subscribe(AgentCatalogTopic, (e) => ({
          type: '_agentCatalog' as const,
          agents: e.agents,
        }))

        context.subscribe(ToolRegistrationTopic, (e) => ({
          type: '_toolRegistration' as const,
          event: e,
        }))

        const server = startServer({
          port,
          PUBLIC_DIR,
          MEDIA_DIR,
          checkAdmin: (roles) => canAccessAdminSurface(identityProviderRef, roles),
          resolveIdentity: (ticket) => resolveIdentity(identityProviderRef, r => ({ type: 'resolveTicket', ticket, replyTo: r })),
          resolveCookieIdentity: (req) => resolveCookieIdentity(identityProviderRef, req),
          authorizeConfigAccess: (req, url, identity, opts) => authorizeConfigAccess(identityProviderRef, req, url, identity, opts),
          resolveRegisteredRoute: (method, pathname) => resolveRegisteredRoute(method, pathname),
          fetchModels: async () => {
            if (llmProviderRef) {
              return await ask(llmProviderRef, replyTo => ({ type: 'fetchModels' as const, replyTo }), { timeoutMs: 10_000 })
            }
            throw new Error('No LLM Provider')
          },
          getConfigSchemas: () => [...configSchemas.values()],
          onConnect: (client) => {
            selfRef?.send({ type: 'connected', clientId: client.clientId, userId: client.userId, roles: client.roles })
          },
          onDisconnect: (clientId) => {
            selfRef?.send({ type: 'closed', clientId })
          },
          onMessage: (clientId, userId, text, attachments) => {
            selfRef?.send({ type: 'message', clientId, userId, text, attachments })
          },
          onWsFrame: (clientId, userId, roles, frame) => {
            selfRef?.send({ type: '_wsFrame', clientId, userId, roles, frame })
          },
          onConfigUpdate: (pluginId, patch) => {
            selfRef?.send({ type: '_configUpdate', pluginId, patch })
          }
        })

        context.log.info(`listening on http://localhost:${server.port}`)
        console.log(`🌍 listening on http://localhost:${server.port}`)
        return { state: { ...state, server } }
      },

      stopped: (state, context) => {
        if (!state.server) return { state }
        context.log.info('stopping HTTP server')
        state.server.stop(true)
        return { state: { ...state, server: null } }
      },
    }),
  }
}
