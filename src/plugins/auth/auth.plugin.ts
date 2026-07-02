import { createPluginFactory, defineConfig } from '../../system/index.ts'
import type { ActorRef } from '../../system/index.ts'
import { UserStore } from './user-store.ts'
import { Authenticator, type AuthConfig } from './authenticator.ts'
import { IdentityProvider } from './identity-provider.ts'
import { buildAuthRoutes, authSchemas } from './routes.ts'
import type { UiSurfaceRegistration } from '../../types/ui-surface.ts'
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

const authSurfaceRegistration: UiSurfaceRegistration = {
  id: 'auth.profile',
  version: '0.1.0',
  view: {
    title: 'Profile',
    icon: 'user',
    contentTag: 'r-auth-profile',
  },
  moduleUrl: '/plugins/auth/ui/index.js',
  frameTypes: [],
}

export default createPluginFactory<AuthConfig>({
  id:      'auth',
  version: '0.1.0',
  description: 'Authentication and session tracking plugin',
  configDescriptor: config,
  slots: {
    userStore: {
      factory: () => UserStore('./workspace/auth/users.json'),
      surviveConfigChange: true,
    },
    authenticator: {
      factory: (cfg: AuthConfig, deps) => Authenticator({
        userStore: deps.userStore as ActorRef<UserStoreMsg>,
        config: cfg,
      }),
      dependsOn: ['userStore'],
    },
    identityProvider: {
      factory: (cfg, deps) => IdentityProvider({
        authenticator: deps.authenticator as ActorRef<AuthenticatorMsg>,
        userStore: deps.userStore as ActorRef<UserStoreMsg>,
      }),
      dependsOn: ['authenticator', 'userStore'],
    },
  },
  routes: (cfg, deps) => {
    return buildAuthRoutes(deps.authenticator as ActorRef<AuthenticatorMsg>)
  },
  uiSurface: authSurfaceRegistration,
})
