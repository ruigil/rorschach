import type { ActorRef, PluginDef } from '../../system/types.ts'
import { onLifecycle } from '../../system/match.ts'
import { IdentityProviderTopic } from '../../types/identity.ts'
import type { IdentityProviderMsg } from '../../types/identity.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import { createUserStoreActor, initialUserStoreState } from './user-store.ts'
import { createAuthenticatorActor, initialAuthenticatorState } from './authenticator.ts'
import { createIdentityProviderActor, initialIdentityProviderState } from './identity-provider.ts'
import { buildAuthRoutes } from './routes.ts'
import type { AuthConfig } from './authenticator.ts'
import type { AuthenticatorMsg, UserStoreMsg } from './types.ts'

type AuthPluginState = {
  userStore:        ActorRef<UserStoreMsg>        | null
  authenticator:    ActorRef<AuthenticatorMsg>    | null
  identityProvider: ActorRef<IdentityProviderMsg> | null
}

const authPlugin: PluginDef<never, AuthPluginState, AuthConfig> = {
  id:      'auth',
  version: '0.1.0',

  configDescriptor: {
    defaults: {
      rpId:           'localhost',
      rpName:         'Rorschach',
      origin:         'http://localhost:3000',
      baseUrl:        'http://localhost:3000',
      sessionTtlMs:   7 * 24 * 60 * 60 * 1000,   // 7 days
      challengeTtlMs: 5 * 60 * 1000,              // 5 min
      ticketTtlMs:    30 * 1000,                  // 30 s (single-use WS tickets)
    },
  },

  initialState: { userStore: null, authenticator: null, identityProvider: null },

  lifecycle: onLifecycle({
    start: (state, ctx) => {
      const config      = ctx.initialConfig() as AuthConfig
      const storePath   = './workspace/auth/users.json'
      const userStore        = ctx.spawn('user-store',        createUserStoreActor(storePath),                                  initialUserStoreState())
      const authenticator    = ctx.spawn('authenticator',     createAuthenticatorActor({ userStore, config }),                  initialAuthenticatorState())
      const identityProvider = ctx.spawn('identity-provider', createIdentityProviderActor({ authenticator, userStore }),        initialIdentityProviderState())

      // Public protocol — other plugins talk through this single retained topic.
      ctx.publishRetained(IdentityProviderTopic, 'identity-provider', { ref: identityProvider as ActorRef<IdentityProviderMsg> })

      // Register all /auth/* REST routes via the generic HTTP route topic.
      for (const reg of buildAuthRoutes(authenticator)) {
        ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
      }

      ctx.log.info('auth plugin activated')
      return { state: { userStore, authenticator, identityProvider } }
    },

    stopped: (state, ctx) => {
      ctx.deleteRetained(IdentityProviderTopic, 'identity-provider', { ref: null })

      // Unregister /auth/* routes (publish tombstones).
      for (const reg of buildAuthRoutes(state.authenticator!)) {
        ctx.deleteRetained(RouteRegistrationTopic, reg.id, { id: reg.id, method: reg.method, path: reg.path, handler: null })
      }

      ctx.log.info('auth plugin deactivated')
      return { state }
    },
  }),

  handler: (state: AuthPluginState) => ({ state }),
}

export default authPlugin
