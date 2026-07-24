import { join } from 'node:path'
import type { Server } from 'bun'
import { emit } from '../../system/index.ts'
import {
  InboundMessageTopic,
  UserPresenceTopic,
  OutboundUserMessageTopic,
  OutboundBroadcastTopic,
  OutboundAdminBroadcastTopic,
  HttpWsFrameTopic,
  type MessageAttachment,
} from '../../types/events.ts'
import type { ActorDef, ActorRef, SpanHandle } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import type { RouteRegistration, HttpRequestMsg } from '../../types/routes.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import { IdentityProviderTopic } from '../../types/identity.ts'
import { resolveIdentity, resolveCookieIdentity, ConfigUpdateRequestTopic } from './types.ts'
import type { IdentityProviderMsg } from '../../types/identity.ts'


import { ask } from '../../system/index.ts'
import { PersistenceProviderTopic } from '../../types/persistence.ts'
import type { PersistenceMsg, PResult } from '../../types/persistence.ts'

import { canAccessAdminSurface, authorizeConfigAccess } from './http/security.ts'
import { startServer, type WsData } from './http/server.ts'

// Re-export helpers imported by other files (e.g. tests)
export { canAccessAdminSurface, authorizeConfigAccess }

// ─── Public directory (build output served by the HTTP handler) ───
const PUBLIC_DIR = join(process.cwd(), 'src', 'frontend', 'static')


// ─── Message protocol ───

export type HttpMessage =
  | { type: 'connected'; clientId: string; userId: string; roles: string[]; timezone?: string }
  | { type: 'message'; clientId: string; userId: string; text: string; attachments?: MessageAttachment[] }
  | { type: '_wsFrame'; clientId: string; userId: string; roles: string[]; frame: any }
  | { type: '_persistenceRef'; ref: ActorRef<PersistenceMsg> | null }
  | { type: 'closed'; clientId: string }
  | { type: '_broadcast'; broadType: string; key: string; payload: any; isTombstone?: boolean; isAdmin?: boolean }
  | { type: 'send'; userId: string; text: string }
  | { type: '_configUpdate'; pluginId: string; patch: Record<string, unknown> }
  | { type: '_identityProviderChanged'; ref: ActorRef<IdentityProviderMsg> | null }
  | { type: '_routeChanged'; reg: RouteRegistration }

// ─── Actor state ───

export type HttpState = {
  server:              Server<WsData> | null
  connections:         number
  activeSpans:         Record<string, SpanHandle>
  identityProviderRef: ActorRef<IdentityProviderMsg> | null
  userIdsToClientIds:  Record<string, string[]>
  retainedBroadcasts:  Record<string, { type: string; payload: any }>
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
  let identityProviderRef: ActorRef<IdentityProviderMsg> | null = null
  let persistenceRef:      ActorRef<PersistenceMsg>      | null = null
  const retainedAdminBroadcastsMap = new Map<string, { type: string; payload: any }>()
  type RouteMatch = NonNullable<RouteRegistration['match']>
  type RouteRecord = { method: string; path: string; match: RouteMatch; target: ActorRef<HttpRequestMsg> }

  const routes = new Map<string, RouteRecord>()
  const routeKey = (method: string, path: string, match: RouteMatch = 'exact') => `${method.toUpperCase()} ${match} ${path}`

  const publishFrame = (server: Server<WsData> | null, target: string, type: string, payload: any) => {
    if (!server) return
    let obj = payload
    if (typeof payload === 'string') {
      try {
        obj = JSON.parse(payload)
      } catch {
        // Not a JSON string
      }
    }
    if (obj && typeof obj === 'object') {
      server.publish(target, JSON.stringify({ type, ...obj }))
    } else {
      server.publish(target, payload)
    }
  }

  const resolveRegisteredRoute = (method: string, pathname: string): ActorRef<HttpRequestMsg> | undefined => {
    const upperMethod = method.toUpperCase()
    const exact = routes.get(routeKey(upperMethod, pathname, 'exact'))
    if (exact) return exact.target

    let best: RouteRecord | undefined
    for (const route of routes.values()) {
      if (route.method !== upperMethod || route.match !== 'prefix') continue
      if (!pathname.startsWith(route.path)) continue
      if (!best || route.path.length > best.path.length) best = route
    }
    return best?.target
  }

  return {
    initialState: { server: null, connections: 0, activeSpans: {}, identityProviderRef: null, userIdsToClientIds: {}, retainedBroadcasts: {} },
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
            timezone: message.timezone,
          }))
        }

        for (const event of Object.values(state.retainedBroadcasts)) {
          publishFrame(state.server, `client:${message.clientId}`, event.type, event.payload)
        }
        return {
          state: { ...state, connections, userIdsToClientIds },
          events,
        }
      },



      _wsFrame: (state, message, context) => {
        context.log.debug(`[${message.clientId}] WS frame: ${JSON.stringify(message.frame)}`)
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

      _broadcast: (state, message) => {
        const channel = message.isAdmin ? ADMIN_CHANNEL : CHANNEL
        publishFrame(state.server, channel, message.broadType, message.payload)

        const isCacheable = message.broadType === 'ui.surface' || message.broadType === 'config.schema' || message.broadType === 'agents'
        if (!isCacheable) {
          return { state }
        }

        if (message.isAdmin) {
          if (message.isTombstone) {
            retainedAdminBroadcastsMap.delete(message.key)
          } else {
            retainedAdminBroadcastsMap.set(message.key, { type: message.broadType, payload: message.payload })
          }
          return { state }
        } else {
          const nextRetained = { ...state.retainedBroadcasts }
          if (message.isTombstone) {
            delete nextRetained[message.key]
          } else {
            nextRetained[message.key] = { type: message.broadType, payload: message.payload }
          }
          return { state: { ...state, retainedBroadcasts: nextRetained } }
        }
      },

      _persistenceRef: (state, message) => {
        persistenceRef = message.ref
        return { state }
      },

      message: (state, message, context) => {
        context.log.debug(`[${message.clientId}] ${message.text}`)
        const span = context.trace.start('request', { clientId: message.clientId })
        
        return {
          state: { ...state, activeSpans: { ...state.activeSpans, [message.clientId]: span } },
          events: [emit(InboundMessageTopic, {
            userId: message.userId,
            text: message.text,
            attachments: message.attachments,
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

      _configUpdate: (state, message, context) => {
        context.publish(ConfigUpdateRequestTopic, {
          pluginId: message.pluginId,
          patch: message.patch,
        })
        return { state }
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
        if (reg.target === null) routes.delete(key)
        else routes.set(key, { method, path: reg.path, match, target: reg.target })
        return { state }
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

        context.subscribe(OutboundBroadcastTopic, (e) => ({
          type: '_broadcast' as const,
          broadType: e.type,
          key: e.key,
          payload: e.payload,
          isTombstone: e.isTombstone,
        }))

        context.subscribe(OutboundAdminBroadcastTopic, (e) => ({
          type: '_broadcast' as const,
          broadType: e.type,
          key: e.key,
          payload: e.payload,
          isTombstone: e.isTombstone,
          isAdmin: true,
        }))

        context.subscribe(IdentityProviderTopic, (e) => ({
          type: '_identityProviderChanged' as const,
          ref: e.ref,
        }))

        context.subscribe(PersistenceProviderTopic, (e) => ({
          type: '_persistenceRef' as const,
          ref: e.ref,
        }))

        context.subscribe(RouteRegistrationTopic, (reg) => ({
          type: '_routeChanged' as const,
          reg,
        }))


        const server = startServer({
          port,
          PUBLIC_DIR,
          MEDIA_DIR: '',
          checkAdmin: (roles) => canAccessAdminSurface(identityProviderRef, roles),
          resolveIdentity: (ticket) => resolveIdentity(identityProviderRef, r => ({ type: 'resolveTicket', ticket, replyTo: r })),
          resolveCookieIdentity: (req) => resolveCookieIdentity(identityProviderRef, req),
          authorizeConfigAccess: (req, url, identity, opts) => authorizeConfigAccess(identityProviderRef, req, url, identity, opts),
          resolveRegisteredRoute: (method, pathname) => resolveRegisteredRoute(method, pathname),
          getConfigSchemas: () => {
            const schemas: ConfigSchemaSection[] = [];
            for (const event of retainedAdminBroadcastsMap.values()) {
              if (event.type === 'config.schema') {
                const payload = event.payload;
                const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
                if (parsed?.section) {
                  schemas.push(parsed.section);
                }
              }
            }
            return schemas;
          },
          onConnect: (client) => {
            selfRef?.send({ type: 'connected', clientId: client.clientId, userId: client.userId, roles: client.roles, timezone: client.timezone })
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
          },
          uploadMedia: async (key, stream, contentType) => {
            if (!persistenceRef) {
              return { ok: false, error: 'Persistence actor not available' }
            }
            return await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
              type: 'obj.putStream',
              bucket: 'media',
              key,
              stream,
              meta: { contentType },
              replyTo,
            }))
          },
          fetchMedia: async (key) => {
            if (!persistenceRef) {
              return null
            }
            const res = await ask<PersistenceMsg, PResult<any>>(persistenceRef, (replyTo) => ({
              type: 'obj.getStream',
              bucket: 'media',
              key,
              replyTo,
            }))
            if (res.ok && res.data) {
              return {
                stream: res.data.stream,
                mimeType: res.data.meta?.contentType || 'application/octet-stream'
              }
            }
            return null
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
