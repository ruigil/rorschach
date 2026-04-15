import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
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
import { LlmProviderTopic, CostTopic } from '../../types/llm.ts'
import type { LlmProviderMsg, CostEvent } from '../../types/llm.ts'
import { KgraphTopic } from '../../types/memory.ts'
import type { KgraphMsg, KgraphGraph } from '../../types/memory.ts'
import { AuthenticatorTopic } from '../auth/types.ts'
import type { AuthenticatorMsg, AuthSession, RegistrationBeginResult, AuthenticationBeginResult } from '../auth/types.ts'

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
  | { type: 'connected'; clientId: string; userId: string | null; roles: string[] }
  | { type: 'message'; clientId: string; text: string; images?: string[]; audio?: string; pdfs?: Array<{ data: string; name: string }> }
  | { type: '_mediaSaved'; clientId: string; text: string; imagePaths: string[]; audioPath?: string; pdfPaths?: string[] }
  | { type: 'closed'; clientId: string }
  | { type: 'broadcast'; text: string }
  | { type: 'send'; clientId: string; text: string }
  | { type: 'config'; data: unknown }
  | { type: '_configSnapshot'; data: Record<string, unknown> }
  | { type: '_llmProviderChanged'; ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_kgraphChanged'; ref: ActorRef<KgraphMsg> | null }
  | { type: '_authenticatorChanged'; ref: ActorRef<AuthenticatorMsg> | null }
  | { type: '_imageGenerated'; publicUrl: string }
  | { type: '_audioGenerated'; publicUrl: string }
  | { type: '_cost'; event: CostEvent }

// ─── Image helpers ───

const saveImagesToTempFiles = (images: string[]): Promise<string[]> =>
  Promise.all(images.map(async (dataUrl) => {
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/)
    const ext = match?.[1] ?? 'jpeg'
    const data = match?.[2] ?? ''
    const filePath = join(INBOUND_DIR, `rorschach-${crypto.randomUUID()}.${ext}`)
    await mkdir(INBOUND_DIR, { recursive: true })
    await Bun.write(filePath, Buffer.from(data, 'base64'))
    return filePath
  }))

const saveAudioToTempFile = async (dataUrl: string): Promise<string> => {
  const match = dataUrl.match(/^data:audio\/(\w+);base64,(.+)$/)
  const ext  = match?.[1] ?? 'wav'
  const data = match?.[2] ?? ''
  const filePath = join(INBOUND_DIR, `rorschach-${crypto.randomUUID()}.${ext}`)
  await mkdir(INBOUND_DIR, { recursive: true })
  await Bun.write(filePath, Buffer.from(data, 'base64'))
  return filePath
}

const savePdfsToTempFiles = (pdfs: Array<{ data: string; name: string }>): Promise<string[]> =>
  Promise.all(pdfs.map(async ({ data, name }) => {
    const match = data.match(/^data:[^;]+;base64,(.+)$/)
    const b64 = match?.[1] ?? data
    const filePath = join(INBOUND_DIR, `rorschach-${crypto.randomUUID()}-${name}`)
    await mkdir(INBOUND_DIR, { recursive: true })
    await Bun.write(filePath, Buffer.from(b64, 'base64'))
    return filePath
  }))

// ─── Actor state ───

export type HttpState = {
  server:           Server<WsData> | null
  connections:      number
  activeSpans:      Record<string, SpanHandle>
  llmProviderRef:   ActorRef<LlmProviderMsg>   | null
  kgraphRef:        ActorRef<KgraphMsg>         | null
  authenticatorRef: ActorRef<AuthenticatorMsg>  | null
}

// ─── WebSocket attachment data ───

type WsData = { clientId: string; userId: string | null; roles: string[] }

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
  let selfRef:          ActorRef<HttpMessage>    | null = null
  let llmProviderRef:   ActorRef<LlmProviderMsg> | null = null
  let kgraphRef:        ActorRef<KgraphMsg>       | null = null
  let authenticatorRef: ActorRef<AuthenticatorMsg>| null = null
  let configSnapshot:   Record<string, unknown>   | null = null

  return {
    handler: onMessage({

      connected: (state, message, context) => {
        const connections = state.connections + 1
        context.log.info(`client connected: ${message.clientId} userId=${message.userId ?? 'anon'} (${connections} total)`)
        return {
          state: { ...state, connections },
          events: [emit(WsConnectTopic, { clientId: message.clientId, userId: message.userId, roles: message.roles })],
        }
      },

      message: (state, message, context) => {
        context.log.debug(`[${message.clientId}] ${message.text}`)
        const span = context.trace.start('request', { clientId: message.clientId })
        const newState = { ...state, activeSpans: { ...state.activeSpans, [message.clientId]: span } }

        if ((message.images && message.images.length > 0) || message.audio || (message.pdfs && message.pdfs.length > 0)) {
          context.pipeToSelf(
            Promise.all([
              message.images && message.images.length > 0 ? saveImagesToTempFiles(message.images) : Promise.resolve([]),
              message.audio ? saveAudioToTempFile(message.audio) : Promise.resolve(undefined),
              message.pdfs && message.pdfs.length > 0 ? savePdfsToTempFiles(message.pdfs) : Promise.resolve([]),
            ]).then(([imagePaths, audioPath, pdfPaths]) => ({ imagePaths, audioPath, pdfPaths })),
            ({ imagePaths, audioPath, pdfPaths }): HttpMessage => ({ type: '_mediaSaved', clientId: message.clientId, text: message.text, imagePaths, audioPath, pdfPaths }),
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
        const { clientId, text, imagePaths, audioPath, pdfPaths } = message
        const span = state.activeSpans[clientId]
        if (!span) return { state }
        return {
          state,
          events: [emit(WsMessageTopic, {
            clientId,
            text,
            images: imagePaths.length > 0 ? imagePaths : undefined,
            audio: audioPath,
            pdfs: pdfPaths && pdfPaths.length > 0 ? pdfPaths : undefined,
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
        if (event.clientId) {
          state.server?.publish(`client:${event.clientId}`, text)
        } else {
          state.server?.publish(CHANNEL, text)
        }
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

      _authenticatorChanged: (state, message) => {
        authenticatorRef = message.ref
        return { state: { ...state, authenticatorRef: message.ref } }
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

        context.subscribe(CostTopic, (event) => ({
          type: '_cost' as const,
          event,
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

        context.subscribe(AuthenticatorTopic, (e) => ({
          type: '_authenticatorChanged' as const,
          ref: e.ref,
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

            // Current user identity
            if (req.method === 'GET' && url.pathname === '/me') {
              const cookieToken = req.headers.get('cookie')?.split(';')
                .reduce<string | null>((found, pair) => {
                  const [k, v] = pair.trim().split('=')
                  return k === 'session' ? (v ?? null) : found
                }, null) ?? null
              if (!cookieToken || !authenticatorRef) {
                return new Response(JSON.stringify({ userId: null }), { headers: { 'Content-Type': 'application/json' } })
              }
              const session = await ask<AuthenticatorMsg, AuthSession | null>(authenticatorRef, (r) => ({ type: 'validateToken' as const, token: cookieToken, replyTo: r }), { timeoutMs: 3_000 })
              return new Response(JSON.stringify({ userId: session?.userId ?? null }), { headers: { 'Content-Type': 'application/json' } })
            }

            // Kgraph dump API
            if (req.method === 'GET' && url.pathname === '/kgraph') {
              const cookieToken = req.headers.get('cookie')?.split(';')
                .reduce<string | null>((found, pair) => {
                  const [k, v] = pair.trim().split('=')
                  return k === 'session' ? (v ?? null) : found
                }, null) ?? null
              if (!cookieToken || !authenticatorRef) {
                return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
              }
              const session = await ask<AuthenticatorMsg, AuthSession | null>(authenticatorRef, (r) => ({ type: 'validateToken' as const, token: cookieToken, replyTo: r }), { timeoutMs: 3_000 })
              if (!session?.userId) {
                return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
              }
              const graph: KgraphGraph = kgraphRef
                ? await ask(kgraphRef, replyTo => ({ type: 'dump' as const, replyTo, userId: session.userId }), { timeoutMs: 5_000 })
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

            // ─── Auth REST routes ───

            const getCookieToken = (r: Request): string | null => {
              const cookies = r.headers.get('cookie') ?? ''
              return cookies.split(';').reduce<string | null>((found, pair) => {
                const [k, v] = pair.trim().split('=')
                return k === 'session' ? (v ?? null) : found
              }, null)
            }

            const SESSION_MAX_AGE = 7 * 24 * 60 * 60  // 7 days in seconds
            const sessionCookie = (token: string): string =>
              `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}`

            if (req.method === 'GET' && url.pathname === '/auth/register/options') {
              if (!authenticatorRef) return new Response('Auth unavailable', { status: 503 })
              const challengeId = url.searchParams.get('challenge')
              if (!challengeId) return new Response('challenge required', { status: 400 })
              const result = await ask<AuthenticatorMsg, import('../auth/types.ts').RegistrationOptions | null>(authenticatorRef, (r) => ({ type: 'getRegOptions' as const, challengeId, replyTo: r }), { timeoutMs: 5_000 })
              if (!result) return new Response(JSON.stringify({ error: 'challenge not found or expired' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
              return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
            }

            if (req.method === 'GET' && url.pathname === '/auth/register/status') {
              if (!authenticatorRef) return new Response('Auth unavailable', { status: 503 })
              const challengeId = url.searchParams.get('challenge')
              if (!challengeId) return new Response('challenge required', { status: 400 })
              const result = await ask<AuthenticatorMsg, { token: string } | { pending: true } | { error: string }>(authenticatorRef, (r) => ({ type: 'pollRegistration' as const, challengeId, replyTo: r }), { timeoutMs: 5_000 })
              if ('error' in result) return new Response(JSON.stringify({ status: 'error', error: result.error }), { status: 400, headers: { 'Content-Type': 'application/json' } })
              if ('pending' in result) return new Response(JSON.stringify({ status: 'pending' }), { headers: { 'Content-Type': 'application/json' } })
              return new Response(JSON.stringify({ status: 'fulfilled' }), {
                headers: { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie(result.token) },
              })
            }

            if (req.method === 'POST' && url.pathname === '/auth/register/begin') {
              if (!authenticatorRef) return new Response('Auth unavailable', { status: 503 })
              try {
                const body = await req.json() as { phone?: string }
                if (!body.phone) return new Response('phone required', { status: 400 })
                const result = await ask<AuthenticatorMsg, RegistrationBeginResult | { error: string }>(authenticatorRef, (r) => ({ type: 'beginRegistration' as const, phone: body.phone!, replyTo: r }), { timeoutMs: 5_000 })
                if ('error' in result) return new Response(JSON.stringify(result), { status: 400, headers: { 'Content-Type': 'application/json' } })
                return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
              } catch { return new Response('Bad request', { status: 400 }) }
            }

            if (req.method === 'POST' && url.pathname === '/auth/register/finish') {
              if (!authenticatorRef) return new Response('Auth unavailable', { status: 503 })
              try {
                const body = await req.json() as { challengeId?: string; credential?: unknown }
                if (!body.challengeId || !body.credential) return new Response('missing fields', { status: 400 })
                const result = await ask<AuthenticatorMsg, { token: string } | { error: string }>(authenticatorRef, (r) => ({ type: 'finishRegistration' as const, challengeId: body.challengeId!, credential: body.credential as import('../auth/types.ts').WebAuthnCredential, replyTo: r }), { timeoutMs: 15_000 })
                if ('error' in result) return new Response(JSON.stringify(result), { status: 400, headers: { 'Content-Type': 'application/json' } })
                return new Response(JSON.stringify({ ok: true }), {
                  headers: { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie(result.token) },
                })
              } catch { return new Response('Bad request', { status: 400 }) }
            }

            if (req.method === 'POST' && url.pathname === '/auth/login/begin') {
              if (!authenticatorRef) return new Response('Auth unavailable', { status: 503 })
              const result = await ask<AuthenticatorMsg, AuthenticationBeginResult | { error: string }>(authenticatorRef, (r) => ({ type: 'beginAuthentication' as const, replyTo: r }), { timeoutMs: 5_000 })
              if ('error' in result) return new Response(JSON.stringify(result), { status: 400, headers: { 'Content-Type': 'application/json' } })
              return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
            }

            if (req.method === 'GET' && url.pathname === '/auth/login/options') {
              if (!authenticatorRef) return new Response('Auth unavailable', { status: 503 })
              const challengeId = url.searchParams.get('challenge')
              if (!challengeId) return new Response('challenge required', { status: 400 })
              const result = await ask<AuthenticatorMsg, import('../auth/types.ts').AuthenticationOptions | null>(authenticatorRef, (r) => ({ type: 'getAuthOptions' as const, challengeId, replyTo: r }), { timeoutMs: 5_000 })
              if (!result) return new Response(JSON.stringify({ error: 'challenge not found or expired' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
              return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
            }

            if (req.method === 'POST' && url.pathname === '/auth/login/finish') {
              if (!authenticatorRef) return new Response('Auth unavailable', { status: 503 })
              try {
                const body = await req.json() as { challengeId?: string; credential?: unknown }
                if (!body.challengeId || !body.credential) return new Response('missing fields', { status: 400 })
                const result = await ask<AuthenticatorMsg, { token: string } | { error: string }>(authenticatorRef, (r) => ({ type: 'finishAuthentication' as const, challengeId: body.challengeId!, credential: body.credential as import('../auth/types.ts').WebAuthnCredential, replyTo: r }), { timeoutMs: 15_000 })
                if ('error' in result) return new Response(JSON.stringify(result), { status: 400, headers: { 'Content-Type': 'application/json' } })
                return new Response(JSON.stringify({ ok: true }), {
                  headers: { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie(result.token) },
                })
              } catch { return new Response('Bad request', { status: 400 }) }
            }

            if (req.method === 'GET' && url.pathname === '/auth/login/status') {
              if (!authenticatorRef) return new Response('Auth unavailable', { status: 503 })
              const challengeId = url.searchParams.get('challenge')
              if (!challengeId) return new Response('challenge required', { status: 400 })
              const result = await ask<AuthenticatorMsg, { token: string } | { pending: true } | { error: string }>(authenticatorRef, (r) => ({ type: 'pollChallenge' as const, challengeId, replyTo: r }), { timeoutMs: 5_000 })
              if ('error' in result) return new Response(JSON.stringify({ status: 'error', error: result.error }), { status: 400, headers: { 'Content-Type': 'application/json' } })
              if ('pending' in result) return new Response(JSON.stringify({ status: 'pending' }), { headers: { 'Content-Type': 'application/json' } })
              return new Response(JSON.stringify({ status: 'fulfilled' }), {
                headers: { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie(result.token) },
              })
            }

            if (req.method === 'POST' && url.pathname === '/auth/ticket') {
              if (!authenticatorRef) return new Response('Auth unavailable', { status: 503 })
              const token = getCookieToken(req)
              if (!token) return new Response('Unauthorized', { status: 401 })
              const result = await ask<AuthenticatorMsg, { ticket: string } | { error: string }>(authenticatorRef, (r) => ({ type: 'issueTicket' as const, token, replyTo: r }), { timeoutMs: 5_000 })
              if ('error' in result) return new Response('Unauthorized', { status: 401 })
              return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
            }

            if (req.method === 'POST' && url.pathname === '/auth/logout') {
              const token = getCookieToken(req)
              if (token && authenticatorRef) authenticatorRef.send({ type: 'revokeToken', token })
              return new Response(null, {
                status: 204,
                headers: { 'Set-Cookie': 'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' },
              })
            }

            // ─── WebSocket upgrade ───
            if (url.pathname === '/ws') {
              const ticket = url.searchParams.get('ticket') ?? ''
              let session: AuthSession | null | { userId: null; roles: string[] } = null
              if (authenticatorRef) {
                session = await ask(authenticatorRef, (r) => ({ type: 'validateTicket' as const, ticket, replyTo: r }), { timeoutMs: 3_000 })
              } else {
                // Auth plugin not active — allow anonymous connections
                session = { userId: null, roles: [] }
              }
              if (!session) return new Response('Unauthorized', { status: 401 })
              const clientId = crypto.randomUUID()
              const upgraded = server.upgrade(req, { data: { clientId, userId: session.userId, roles: session.roles } })
              if (!upgraded) return new Response('WebSocket upgrade failed', { status: 400 })
              return undefined as unknown as Response
            }

            // Static file serving
            const isMedia = url.pathname.startsWith('/inbound/') || url.pathname.startsWith('/generated/')
            const filePath = url.pathname === '/'
              ? join(PUBLIC_DIR, 'index.html')
              : isMedia
                ? join(MEDIA_DIR, url.pathname)
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
              selfRef?.send({ type: 'connected', clientId: ws.data.clientId, userId: ws.data.userId, roles: ws.data.roles })
            },
            message: (ws: ServerWebSocket<WsData>, message) => {
              const raw = typeof message === 'string' ? message : message.toString()
              let text = raw
              let images: string[] | undefined
              let audio: string | undefined
              let pdfs: Array<{ data: string; name: string }> | undefined
              try {
                const parsed = JSON.parse(raw) as { text?: string; images?: string[]; audio?: string; pdfs?: Array<{ data: string; name: string }> }
                if (typeof parsed.text === 'string') {
                  text = parsed.text
                  images = parsed.images
                  audio = parsed.audio
                  pdfs = parsed.pdfs
                }
              } catch { /* plain text, no images */ }
              selfRef?.send({ type: 'message', clientId: ws.data.clientId, text, images, audio, pdfs })
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
