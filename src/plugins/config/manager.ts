import type { ActorContext, ActorDef, ActorRef } from '../../system/index.ts'
import { onMessage, onLifecycle } from '../../system/index.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import { ConfigSchemaTopic, SystemConfigUpdateTopic } from '../../types/config.ts'
import { OutboundAdminBroadcastTopic } from '../../types/events.ts'
import type { ConfigMsg, ConfigState, PendingRequest } from './types.ts'

const REQUEST_TIMEOUT_MS = 30_000

const getBodyText = (body: string | Uint8Array | null | undefined): string => {
  if (!body) return '{}'
  if (typeof body === 'string') return body
  return new TextDecoder().decode(body)
}

const jsonResponse = (status: number, body: unknown) => ({
  type: 'http.response' as const,
  response: {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  },
})

/** Synthetic reply ref routing a topic reply back into this actor as `_updateReply`. */
const selfReplyRef = (ctx: ActorContext<ConfigMsg>, requestId: string): ActorRef<any> => ({
  name: `reply:${requestId}`,
  isAlive: () => true,
  send: (res: any) => ctx.self.send({ type: '_updateReply', requestId, result: res }),
})

/** Registers a pending request, arms its timeout, and allocates the request id
 *  (via the nextRequestId bump). Returns the next state. */
const beginRequest = (
  state: ConfigState,
  ctx: ActorContext<ConfigMsg>,
  requestId: string,
  pending: PendingRequest,
): ConfigState => {
  const pendingRequests = new Map(state.pendingRequests)
  pendingRequests.set(requestId, pending)
  ctx.timers.startSingleTimer(requestId, { type: '_requestTimeout', requestId }, REQUEST_TIMEOUT_MS)
  return { ...state, nextRequestId: state.nextRequestId + 1, pendingRequests }
}

/** Removes a pending request and disarms its timeout. */
const endRequest = (
  state: ConfigState,
  ctx: ActorContext<ConfigMsg>,
  requestId: string,
): { state: ConfigState; pending: PendingRequest | undefined } => {
  const pending = state.pendingRequests.get(requestId)
  if (!pending) return { state, pending: undefined }
  ctx.timers.cancel(requestId)
  const pendingRequests = new Map(state.pendingRequests)
  pendingRequests.delete(requestId)
  return { state: { ...state, pendingRequests }, pending }
}

// ─── Config Actor ────────────────────────────────────────────────────────────
//
// Pure gateway for the unified config plugin: translates HTTP requests and
// tool invocations into SystemConfigUpdateTopic commands (handled by
// wireConfigManager in the composition root) and serves the aggregated config
// schema registry. Authorization is enforced upstream in the HTTP gateway
// (server.ts); the tool path is gated by the tool-permissions system.
//
export const ConfigActor = (): ActorDef<ConfigMsg, ConfigState> => {
  return {
    initialState: () => ({
      schemas: new Map<string, ConfigSchemaSection>(),
      pendingRequests: new Map(),
      nextRequestId: 0,
    }),

    handler: onMessage<ConfigMsg, ConfigState>({
      '_configSchemaChanged': (state, { event }, ctx) => {
        if (!event.payload?.section) return { state }
        const schemas = new Map(state.schemas)
        if (event.isTombstone) {
          schemas.delete(event.key)
        } else {
          schemas.set(event.key, event.payload.section)
        }
        // Republish schema changes to the admin WS channel so open config
        // panels observe new/removed parameter sections without a refresh.
        ctx.publish(OutboundAdminBroadcastTopic, {
          type: 'config.schema',
          key: event.key,
          payload: event.payload,
          ...(event.isTombstone ? { isTombstone: true } : {}),
        })
        return { state: { ...state, schemas } }
      },

      'http.request': (state, message, ctx) => {
        const { request, replyTo } = message
        const url = new URL(request.url, 'http://localhost')
        const path = url.pathname

        // Schemas are served straight from local state — no topic round-trip.
        if (request.method === 'GET' && path === '/config/schema') {
          replyTo.send(jsonResponse(200, Array.from(state.schemas.values())))
          return { state }
        }

        const requestId = `cfg-req-${state.nextRequestId}`
        const replyRef = selfReplyRef(ctx, requestId)
        const dispatch = (pending: PendingRequest): ConfigState =>
          beginRequest(state, ctx, requestId, pending)

        if (request.method === 'GET' && (path === '/config' || path === '/config/plugins' || path.startsWith('/config/values/'))) {
          if (path === '/config/plugins') {
            const nextState = dispatch({ type: 'http', replyTo, extra: { action: 'list' } })
            ctx.publish(SystemConfigUpdateTopic, { action: 'list_plugins', replyTo: replyRef })
            return { state: nextState }
          }

          const pluginId = path.match(/^\/config\/values\/(.+)$/)?.[1]
          const nextState = dispatch({ type: 'http', replyTo, extra: { action: 'get', pluginId } })
          ctx.publish(SystemConfigUpdateTopic, { action: 'get_values', pluginId, replyTo: replyRef })
          return { state: nextState }
        }

        if (request.method === 'PATCH' && path.startsWith('/config/values/')) {
          const pluginId = path.match(/^\/config\/values\/(.+)$/)?.[1]
          if (!pluginId) {
            replyTo.send(jsonResponse(400, { ok: false, error: 'pluginId is required' }))
            return { state }
          }
          let patch: Record<string, unknown> = {}
          try {
            patch = JSON.parse(getBodyText(request.body))
          } catch {}

          const nextState = dispatch({ type: 'http', replyTo })
          ctx.publish(SystemConfigUpdateTopic, { action: 'set_value', pluginId, patch, replyTo: replyRef })
          return { state: nextState }
        }

        if (request.method === 'POST' && (path === '/config/plugins/add' || path === '/config/plugins/remove' || path === '/config/plugins/reload')) {
          let bodyData: any = {}
          try {
            bodyData = JSON.parse(getBodyText(request.body))
          } catch {}

          const nextState = dispatch({ type: 'http', replyTo })
          if (path.endsWith('/add')) {
            ctx.publish(SystemConfigUpdateTopic, { action: 'add_plugin', specifier: bodyData.path ?? bodyData.specifier ?? '', replyTo: replyRef })
          } else if (path.endsWith('/remove')) {
            ctx.publish(SystemConfigUpdateTopic, { action: 'remove_plugin', pluginId: bodyData.id ?? bodyData.pluginId ?? '', replyTo: replyRef })
          } else {
            ctx.publish(SystemConfigUpdateTopic, { action: 'reload_plugin', pluginId: bodyData.id ?? bodyData.pluginId ?? '', replyTo: replyRef })
          }
          return { state: nextState }
        }

        replyTo.send(jsonResponse(404, { error: 'Route not found' }))
        return { state }
      },

      'tool.invoke': (state, message, ctx) => {
        const { toolName, args, replyTo } = message
        const requestId = `cfg-tool-${state.nextRequestId}`
        const replyRef = selfReplyRef(ctx, requestId)
        const dispatch = (): ConfigState =>
          beginRequest(state, ctx, requestId, { type: 'tool', replyTo })

        if (toolName === 'config_set') {
          const { pluginId, patch } = args as { pluginId: string; patch: Record<string, unknown> }
          if (!pluginId) {
            replyTo.send({ type: 'toolError', error: 'pluginId is required' })
            return { state }
          }
          const nextState = dispatch()
          ctx.publish(SystemConfigUpdateTopic, { action: 'set_value', pluginId, patch: patch ?? {}, replyTo: replyRef })
          return { state: nextState }
        }

        if (toolName === 'plugins_load') {
          const { specifier } = args as { specifier: string }
          if (!specifier) {
            replyTo.send({ type: 'toolError', error: 'specifier is required' })
            return { state }
          }
          const nextState = dispatch()
          ctx.publish(SystemConfigUpdateTopic, { action: 'add_plugin', specifier, replyTo: replyRef })
          return { state: nextState }
        }

        if (toolName === 'plugins_unload' || toolName === 'plugins_reload') {
          const { pluginId } = args as { pluginId: string }
          if (!pluginId) {
            replyTo.send({ type: 'toolError', error: 'pluginId is required' })
            return { state }
          }
          const nextState = dispatch()
          ctx.publish(SystemConfigUpdateTopic, {
            action: toolName === 'plugins_unload' ? 'remove_plugin' : 'reload_plugin',
            pluginId,
            replyTo: replyRef,
          })
          return { state: nextState }
        }

        if (toolName === 'config_get') {
          const { pluginId } = args as { pluginId?: string }
          const nextState = dispatch()
          ctx.publish(SystemConfigUpdateTopic, { action: 'get_values', pluginId, replyTo: replyRef })
          return { state: nextState }
        }

        replyTo.send({ type: 'toolError', error: `Unknown tool: ${toolName}` })
        return { state }
      },

      '_updateReply': (state, { requestId, result }, ctx) => {
        const { state: nextState, pending } = endRequest(state, ctx, requestId)
        if (!pending) return { state }

        if (pending.type === 'http') {
          if (result.success) {
            const bodyContent =
              pending.extra?.action === 'list' || pending.extra?.action === 'get'
                ? JSON.stringify(result.details)
                : JSON.stringify({ ok: true, message: result.message, details: result.details })
            pending.replyTo.send({
              type: 'http.response',
              response: {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: bodyContent,
              },
            })
          } else {
            pending.replyTo.send(jsonResponse(400, { ok: false, error: result.error }))
          }
        } else if (result.success) {
          const resultText = result.details !== undefined
            ? JSON.stringify(result.details, null, 2)
            : (result.message || 'Config operation completed successfully.')
          pending.replyTo.send({ type: 'toolResult', result: resultText })
        } else {
          pending.replyTo.send({ type: 'toolError', error: result.error })
        }
        return { state: nextState }
      },

      '_requestTimeout': (state, { requestId }) => {
        const pending = state.pendingRequests.get(requestId)
        if (!pending) return { state }
        const pendingRequests = new Map(state.pendingRequests)
        pendingRequests.delete(requestId)

        if (pending.type === 'http') {
          pending.replyTo.send(jsonResponse(504, { ok: false, error: 'Config request timed out' }))
        } else {
          pending.replyTo.send({ type: 'toolError', error: 'Config operation timed out' })
        }
        return { state: { ...state, pendingRequests } }
      },
    }),

    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(ConfigSchemaTopic, (e) => ({
          type: '_configSchemaChanged' as const,
          event: e,
        }))
        return { state }
      },
    }),
  }
}
