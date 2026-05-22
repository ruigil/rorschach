import type { ActorRef, PluginDef } from '../../system/index.ts'
import { defineConfig, createSlot, stopSlot, publishConfigSurface, deleteConfigSurface, type ActorSlot } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { IdentityProviderTopic } from '../../types/identity.ts'
import type { IdentityProviderMsg } from '../../types/identity.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import { UserStore } from './user-store.ts'
import { Authenticator, type AuthConfig } from './authenticator.ts'
import { IdentityProvider } from './identity-provider.ts'
import { buildAuthRoutes, authSchemas } from './routes.ts'
import type { AuthenticatorMsg, UserStoreMsg } from './types.ts'

const config = defineConfig<AuthConfig>('auth', {
  rpId:           'localhost',
  rpName:         'Rorschach',
  origin:         'http://localhost:3000',
  baseUrl:        'http://localhost:3000',
  sessionTtlMs:   7 * 24 * 60 * 60 * 1000,
  challengeTtlMs: 5 * 60 * 1000,
  ticketTtlMs:    30 * 1000,
  admins:         {},
}, {
  schemas: authSchemas,
})

type AuthPluginMsg = { type: 'config'; slice: AuthConfig | undefined }

type AuthPluginState = {
  initialized:     boolean
  userStore:       ActorSlot<never>
  authenticator:   ActorSlot<AuthConfig>
  identityProvider: ActorSlot<never>
}

const authPlugin: PluginDef<AuthPluginMsg, AuthPluginState, AuthConfig> = {
  id:      'auth',
  version: '0.1.0',

  configDescriptor: config,

  initialState: {
    initialized:     false,
    userStore:       createSlot(),
    authenticator:   createSlot(),
    identityProvider: createSlot(),
  },

  lifecycle: onLifecycle({
    start: (state, ctx) => {
      const authConfig = ctx.initialConfig() as AuthConfig

      publishConfigSurface(ctx, config, () => authConfig)

      const storePath = './workspace/auth/users.json'
      const userStoreRef = ctx.spawn('user-store-0', UserStore(storePath))
      const authenticatorRef = ctx.spawn('authenticator-0', Authenticator({ userStore: userStoreRef as ActorRef<UserStoreMsg>, config: authConfig }))
      const identityProviderRef = ctx.spawn('identity-provider-0', IdentityProvider({ authenticator: authenticatorRef as ActorRef<AuthenticatorMsg>, userStore: userStoreRef as ActorRef<UserStoreMsg> }))

      // Public protocol — other plugins talk through this single retained topic.
      ctx.publishRetained(IdentityProviderTopic, 'identity-provider', { ref: identityProviderRef as ActorRef<IdentityProviderMsg> })

      // Register all /auth/* REST routes via the generic HTTP route topic.
      for (const reg of buildAuthRoutes(authenticatorRef as ActorRef<AuthenticatorMsg>)) {
        ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
      }

      ctx.log.info('auth plugin activated')
      return { state: {
        initialized: true,
        userStore:       { config: null, ref: userStoreRef,       gen: 0 },
        authenticator:   { config: authConfig, ref: authenticatorRef, gen: 0 },
        identityProvider: { config: null, ref: identityProviderRef, gen: 0 },
      } }
    },

    stopped: (state, ctx) => {
      ctx.deleteRetained(IdentityProviderTopic, 'identity-provider', { ref: null })

      // Unregister /auth/* routes (publish tombstones).
      if (state.authenticator.ref) {
        for (const reg of buildAuthRoutes(state.authenticator.ref as ActorRef<AuthenticatorMsg>)) {
          ctx.deleteRetained(RouteRegistrationTopic, reg.id, { id: reg.id, method: reg.method, path: reg.path, handler: null })
        }
      }

      deleteConfigSurface(ctx, config)

      stopSlot(ctx, state.userStore)
      stopSlot(ctx, state.authenticator)
      stopSlot(ctx, state.identityProvider)

      ctx.log.info('auth plugin deactivated')
      return { state }
    },
  }),

  handler: onMessage<AuthPluginMsg, AuthPluginState>({
    config: (state, msg, ctx) => {
      // Unregister old routes
      if (state.authenticator.ref) {
        for (const reg of buildAuthRoutes(state.authenticator.ref as ActorRef<AuthenticatorMsg>)) {
          ctx.deleteRetained(RouteRegistrationTopic, reg.id, { id: reg.id, method: reg.method, path: reg.path, handler: null })
        }
      }

      // Stop identity provider and authenticator (userStore is config-independent)
      stopSlot(ctx, state.identityProvider)
      stopSlot(ctx, state.authenticator)

      const newAuthConfig = msg.slice!
      const userStoreRef = state.userStore.ref!

      // Restart authenticator with new config
      const authenticatorRef = ctx.spawn(
        `authenticator-${state.authenticator.gen + 1}`,
        Authenticator({ userStore: userStoreRef as ActorRef<UserStoreMsg>, config: newAuthConfig })
      )

      // Restart identity provider (depends on authenticator)
      const identityProviderRef = ctx.spawn(
        `identity-provider-${state.identityProvider.gen + 1}`,
        IdentityProvider({ authenticator: authenticatorRef as ActorRef<AuthenticatorMsg>, userStore: userStoreRef as ActorRef<UserStoreMsg> })
      )

      // Re-publish identity provider ref
      ctx.publishRetained(IdentityProviderTopic, 'identity-provider', { ref: identityProviderRef as ActorRef<IdentityProviderMsg> })

      // Re-register routes
      for (const reg of buildAuthRoutes(authenticatorRef as ActorRef<AuthenticatorMsg>)) {
        ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
      }

      ctx.log.info('auth plugin reconfigured')
      return { state: {
        ...state,
        authenticator:   { config: newAuthConfig, ref: authenticatorRef, gen: state.authenticator.gen + 1 },
        identityProvider: { config: null, ref: identityProviderRef, gen: state.identityProvider.gen + 1 },
      } }
    },
  }),
}

export default authPlugin
