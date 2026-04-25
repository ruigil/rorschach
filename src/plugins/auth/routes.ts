import type { ActorRef } from '../../system/types.ts'
import { ask } from '../../system/ask.ts'
import type { RouteRegistration } from '../../types/routes.ts'
import type {
  AuthenticatorMsg,
  RegistrationOptions,
  AuthenticationOptions,
  RegistrationBeginResult,
  AuthenticationBeginResult,
  WebAuthnCredential,
} from './types.ts'

// ─── Cookie helpers ───

const SESSION_MAX_AGE = 7 * 24 * 60 * 60   // 7 days

const sessionCookie = (token: string): string =>
  `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}`

const getCookieToken = (req: Request): string | null => {
  const cookies = req.headers.get('cookie') ?? ''
  return cookies.split(';').reduce<string | null>((found, pair) => {
    const [k, v] = pair.trim().split('=')
    return k === 'session' ? (v ?? null) : found
  }, null)
}

const json = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })

// ─── Build /auth/* route registrations ───
//
// Returns the full set of registrations to publish on plugin start.
// Each handler closes over `authenticator` and uses ask() to drive
// the internal authenticator actor.

export const buildAuthRoutes = (authenticator: ActorRef<AuthenticatorMsg>): RouteRegistration[] => [
  {
    id: 'auth.register.options',
    method: 'GET',
    path: '/auth/register/options',
    handler: async (_req, url) => {
      const challengeId = url.searchParams.get('challenge')
      if (!challengeId) return new Response('challenge required', { status: 400 })
      const result = await ask<AuthenticatorMsg, RegistrationOptions | null>(
        authenticator,
        r => ({ type: 'getRegOptions', challengeId, replyTo: r }),
        { timeoutMs: 5_000 },
      )
      if (!result) return json({ error: 'challenge not found or expired' }, { status: 404 })
      return json(result)
    },
  },

  {
    id: 'auth.register.status',
    method: 'GET',
    path: '/auth/register/status',
    handler: async (_req, url) => {
      const challengeId = url.searchParams.get('challenge')
      if (!challengeId) return new Response('challenge required', { status: 400 })
      const result = await ask<AuthenticatorMsg, { token: string } | { pending: true } | { error: string }>(
        authenticator,
        r => ({ type: 'pollRegistration', challengeId, replyTo: r }),
        { timeoutMs: 5_000 },
      )
      if ('error' in result) return json({ status: 'error', error: result.error }, { status: 400 })
      if ('pending' in result) return json({ status: 'pending' })
      return json({ status: 'fulfilled' }, { headers: { 'Set-Cookie': sessionCookie(result.token) } })
    },
  },

  {
    id: 'auth.register.begin',
    method: 'POST',
    path: '/auth/register/begin',
    handler: async (req) => {
      try {
        const body = await req.json() as { phone?: string }
        if (!body.phone) return new Response('phone required', { status: 400 })
        const result = await ask<AuthenticatorMsg, RegistrationBeginResult | { error: string }>(
          authenticator,
          r => ({ type: 'beginRegistration', phone: body.phone!, replyTo: r }),
          { timeoutMs: 5_000 },
        )
        if ('error' in result) return json(result, { status: 400 })
        return json(result)
      } catch { return new Response('Bad request', { status: 400 }) }
    },
  },

  {
    id: 'auth.register.finish',
    method: 'POST',
    path: '/auth/register/finish',
    handler: async (req) => {
      try {
        const body = await req.json() as { challengeId?: string; credential?: unknown }
        if (!body.challengeId || !body.credential) return new Response('missing fields', { status: 400 })
        const result = await ask<AuthenticatorMsg, { token: string } | { error: string }>(
          authenticator,
          r => ({ type: 'finishRegistration', challengeId: body.challengeId!, credential: body.credential as WebAuthnCredential, replyTo: r }),
          { timeoutMs: 15_000 },
        )
        if ('error' in result) return json(result, { status: 400 })
        return json({ ok: true }, { headers: { 'Set-Cookie': sessionCookie(result.token) } })
      } catch { return new Response('Bad request', { status: 400 }) }
    },
  },

  {
    id: 'auth.login.begin',
    method: 'POST',
    path: '/auth/login/begin',
    handler: async () => {
      const result = await ask<AuthenticatorMsg, AuthenticationBeginResult | { error: string }>(
        authenticator,
        r => ({ type: 'beginAuthentication', replyTo: r }),
        { timeoutMs: 5_000 },
      )
      if ('error' in result) return json(result, { status: 400 })
      return json(result)
    },
  },

  {
    id: 'auth.login.options',
    method: 'GET',
    path: '/auth/login/options',
    handler: async (_req, url) => {
      const challengeId = url.searchParams.get('challenge')
      if (!challengeId) return new Response('challenge required', { status: 400 })
      const result = await ask<AuthenticatorMsg, AuthenticationOptions | null>(
        authenticator,
        r => ({ type: 'getAuthOptions', challengeId, replyTo: r }),
        { timeoutMs: 5_000 },
      )
      if (!result) return json({ error: 'challenge not found or expired' }, { status: 404 })
      return json(result)
    },
  },

  {
    id: 'auth.login.finish',
    method: 'POST',
    path: '/auth/login/finish',
    handler: async (req) => {
      try {
        const body = await req.json() as { challengeId?: string; credential?: unknown }
        if (!body.challengeId || !body.credential) return new Response('missing fields', { status: 400 })
        const result = await ask<AuthenticatorMsg, { token: string } | { error: string }>(
          authenticator,
          r => ({ type: 'finishAuthentication', challengeId: body.challengeId!, credential: body.credential as WebAuthnCredential, replyTo: r }),
          { timeoutMs: 15_000 },
        )
        if ('error' in result) return json(result, { status: 400 })
        return json({ ok: true }, { headers: { 'Set-Cookie': sessionCookie(result.token) } })
      } catch { return new Response('Bad request', { status: 400 }) }
    },
  },

  {
    id: 'auth.login.status',
    method: 'GET',
    path: '/auth/login/status',
    handler: async (_req, url) => {
      const challengeId = url.searchParams.get('challenge')
      if (!challengeId) return new Response('challenge required', { status: 400 })
      const result = await ask<AuthenticatorMsg, { token: string } | { pending: true } | { error: string }>(
        authenticator,
        r => ({ type: 'pollChallenge', challengeId, replyTo: r }),
        { timeoutMs: 5_000 },
      )
      if ('error' in result) return json({ status: 'error', error: result.error }, { status: 400 })
      if ('pending' in result) return json({ status: 'pending' })
      return json({ status: 'fulfilled' }, { headers: { 'Set-Cookie': sessionCookie(result.token) } })
    },
  },

  {
    id: 'auth.ticket',
    method: 'POST',
    path: '/auth/ticket',
    handler: async (req) => {
      const token = getCookieToken(req)
      if (!token) return new Response('Unauthorized', { status: 401 })
      const result = await ask<AuthenticatorMsg, { ticket: string } | { error: string }>(
        authenticator,
        r => ({ type: 'issueTicket', token, replyTo: r }),
        { timeoutMs: 5_000 },
      )
      if ('error' in result) return new Response('Unauthorized', { status: 401 })
      return json(result)
    },
  },

  {
    id: 'auth.logout',
    method: 'POST',
    path: '/auth/logout',
    handler: (req) => {
      const token = getCookieToken(req)
      if (token) authenticator.send({ type: 'revokeToken', token })
      return new Response(null, {
        status: 204,
        headers: { 'Set-Cookie': 'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' },
      })
    },
  },
]
