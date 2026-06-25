import type { ActorDef, ActorRef } from '../../system/index.ts'
import { onMessage, onLifecycle } from '../../system/index.ts'
import { ask } from '../../system/index.ts'
import { IdentityProviderTopic } from '../../types/identity.ts'
import type { IdentityProviderMsg, Identity } from '../../types/identity.ts'
import type { AuthenticatorMsg, AuthSession, UserStoreMsg, User } from './types.ts'

// ─── Identity provider ───
//
// Bridges the generic IdentityProviderMsg protocol into the auth plugin's
// internal AuthenticatorMsg / UserStoreMsg actors. Other plugins talk to this
// actor through IdentityProviderTopic and never see WebAuthn-specific types.
//
// Stateless: each handler fires the underlying ask() and forwards the result.

export type IdentityProviderState = Record<string, never>

const initialIdentityProviderState = (): IdentityProviderState => ({})

const sessionToIdentity = (s: AuthSession): Identity => ({
  userId:   s.userId,
  username: s.username,
  roles:    s.roles,
})

const userToIdentity = (u: User): Identity => ({
  userId:   u.id,
  username: u.username,
  roles:    u.roles,
})

export const IdentityProvider = (opts: {
  authenticator: ActorRef<AuthenticatorMsg>
  userStore:     ActorRef<UserStoreMsg>
}): ActorDef<IdentityProviderMsg, IdentityProviderState> => {
  const { authenticator, userStore } = opts

  return {
    initialState: initialIdentityProviderState,
    handler: onMessage<IdentityProviderMsg, IdentityProviderState>({
      resolveTicket: (state, { ticket, replyTo }) => {
        ask<AuthenticatorMsg, AuthSession | null>(
          authenticator,
          r => ({ type: 'validateTicket', ticket, replyTo: r }),
          { timeoutMs: 3_000 },
        )
          .then(session => replyTo.send(session ? sessionToIdentity(session) : null))
          .catch(() => replyTo.send(null))
        return { state }
      },

      resolveCookie: (state, { cookie, replyTo }) => {
        ask<AuthenticatorMsg, AuthSession | null>(
          authenticator,
          r => ({ type: 'validateToken', token: cookie, replyTo: r }),
          { timeoutMs: 3_000 },
        )
          .then(session => replyTo.send(session ? sessionToIdentity(session) : null))
          .catch(() => replyTo.send(null))
        return { state }
      },

      resolvePhone: (state, { phone, replyTo }) => {
        ask<UserStoreMsg, User | null>(
          userStore,
          r => ({ type: 'getUserByPhone', phone, replyTo: r }),
          { timeoutMs: 3_000 },
        )
          .then(user => replyTo.send(user ? userToIdentity(user) : null))
          .catch(() => replyTo.send(null))
        return { state }
      },
    }),
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.publishRetained(IdentityProviderTopic, 'identity-provider', { ref: ctx.self })
        return { state }
      },
      stopped: (state, ctx) => {
        ctx.deleteRetained(IdentityProviderTopic, 'identity-provider', { ref: null })
        return { state }
      },
    }),
  }
}
