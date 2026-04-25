import { createTopic, type ActorRef } from '../system/types.ts'
import { ask } from '../system/ask.ts'

// ─── Anonymous identity ───
//
// When no identity provider is loaded, every caller resolves to this single
// shared identity. All anonymous users converge on it (intentional collapse).

export const ANONYMOUS_USER_ID = 'anonymous'

export type Identity = {
  userId:   string
  username: string
  roles:    string[]
}

export const ANONYMOUS_IDENTITY: Identity = {
  userId:   ANONYMOUS_USER_ID,
  username: ANONYMOUS_USER_ID,
  roles:    [],
}

// ─── Provider protocol ───
//
// Channel-medium discriminators, not backend-mechanism. Any provider
// implementation (WebAuthn, OAuth, SSO, magic-link, …) handles whichever
// variants make sense for its surface.

export type IdentityProviderMsg =
  | { type: 'resolveTicket'; ticket: string; replyTo: ActorRef<Identity | null> }
  | { type: 'resolveCookie'; cookie: string; replyTo: ActorRef<Identity | null> }
  | { type: 'resolvePhone';  phone:  string; replyTo: ActorRef<Identity | null> }

export const IdentityProviderTopic =
  createTopic<{ ref: ActorRef<IdentityProviderMsg> | null }>('identity.provider')

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
