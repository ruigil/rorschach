import { type ActorRef, ask, createTopic } from '../../system/index.ts'
import type { Identity, IdentityProviderMsg } from '../../types/identity.ts'

// ─── Anonymous identity ───
//
// When no identity provider is loaded, every caller resolves to this single
// shared identity. All anonymous users converge on it (intentional collapse).

export const ANONYMOUS_USER_ID = 'anonymous'

export const ANONYMOUS_IDENTITY: Identity = {
  userId:   ANONYMOUS_USER_ID,
  fullName: ANONYMOUS_USER_ID,
  roles:    [],
}

// ─── Resolver helper ───
//
// no provider ⇒ ANONYMOUS_IDENTITY (auth not loaded — everyone is anonymous)
// provider replies null ⇒ caller decides (HTTP 401, Signal reject)
// provider replies Identity ⇒ real user

export const resolveIdentity = async (
  ref:   ActorRef<IdentityProviderMsg> | null,
  query: (replyTo: ActorRef<Identity | null>) => IdentityProviderMsg,
): Promise<Identity | null> =>
  ref === null ? ANONYMOUS_IDENTITY : ask(ref, query, { timeoutMs: 3_000 })

// ─── Cookie convenience ───
//
// Common one-liner for HTTP routes that authenticate via session cookie.

const SESSION_COOKIE = 'session'

const parseSessionCookie = (req: Request): string =>
  req.headers.get('cookie')?.split(';').reduce<string>((found, pair) => {
    const [k, v] = pair.trim().split('=')
    return k === SESSION_COOKIE ? (v ?? '') : found
  }, '') ?? ''

export const resolveCookieIdentity = async (
  ref: ActorRef<IdentityProviderMsg> | null,
  req: Request,
): Promise<Identity | null> =>
  resolveIdentity(ref, r => ({ type: 'resolveCookie', cookie: parseSessionCookie(req), replyTo: r }))

// ─── Interfaces Config Update ───
export type ConfigUpdateRequest = {
  pluginId: string
  patch: Record<string, unknown>
}

export const ConfigUpdateRequestTopic = createTopic<ConfigUpdateRequest>('config.update.request')


