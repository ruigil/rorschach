import type { ActorRef, PluginDef } from '../../system/types.ts'
import { onLifecycle } from '../../system/match.ts'
import { createUserStoreActor, initialUserStoreState } from './user-store.ts'
import { createAuthenticatorActor, initialAuthenticatorState } from './authenticator.ts'
import type { AuthConfig } from './authenticator.ts'
import type { AuthenticatorMsg, UserStoreMsg } from './types.ts'
import { AuthenticatorTopic, UserStoreTopic } from './types.ts'

type AuthPluginState = {
  userStore:     ActorRef<UserStoreMsg>     | null
  authenticator: ActorRef<AuthenticatorMsg> | null
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

  initialState: { userStore: null, authenticator: null },

  lifecycle: onLifecycle({
    start: (state, ctx) => {
      const config      = ctx.initialConfig() as AuthConfig
      const storePath   = './workspace/auth/users.json'
      const userStore   = ctx.spawn('user-store',   createUserStoreActor(storePath),                    initialUserStoreState())
      const authenticator = ctx.spawn('authenticator', createAuthenticatorActor({ userStore, config }), initialAuthenticatorState())

      ctx.publishRetained(AuthenticatorTopic, 'authenticator', { ref: authenticator as ActorRef<AuthenticatorMsg> })
      ctx.publishRetained(UserStoreTopic,     'user-store',    { ref: userStore     as ActorRef<UserStoreMsg> })

      ctx.log.info('auth plugin activated')
      return { state: { userStore, authenticator } }
    },

    stopped: (state, ctx) => {
      ctx.deleteRetained(AuthenticatorTopic, 'authenticator', { ref: null })
      ctx.deleteRetained(UserStoreTopic,     'user-store',    { ref: null })
      ctx.log.info('auth plugin deactivated')
      return { state }
    },
  }),

  handler: (state: AuthPluginState) => ({ state }),
}

export default authPlugin
