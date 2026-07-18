import type { ActorRef } from '../../system/index.ts'
import type { RouteRegistration, HttpRequestMsg } from '../../types/routes.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'

// ─── Config Schema Sections ──────────────────────────────────────────────────

export const authSchema: ConfigSchemaSection = {
  id: 'auth.config',
  title: 'Authentication',
  subtitle: 'auth · WebAuthn and session settings',
  tab: 'auth',
  configKey: '',
  routeId: 'config.auth',
  schema: {
    type: 'object',
    properties: {
      rpId: { type: 'string', default: 'localhost', 'x-ui': { label: 'Relying party ID' } },
      rpName: { type: 'string', default: 'Rorschach', 'x-ui': { label: 'Relying party name' } },
      origin: { type: 'string', default: 'http://localhost:3000', 'x-ui': { label: 'Origin URL' } },
      baseUrl: { type: 'string', default: 'http://localhost:3000', 'x-ui': { label: 'Base URL' } },
    },
  },
}

export const authAdminsSchema: ConfigSchemaSection = {
  id: 'auth.admins',
  title: 'Admins',
  subtitle: 'auth · privileged runtime configuration access',
  tab: 'auth',
  configKey: 'admins',
  routeId: 'config.auth',
  schema: {
    type: 'object',
    properties: {
      usernames: {
        type: 'string',
        default: '',
        description: 'Comma- or newline-separated usernames granted the admin role.',
        'x-ui': { label: 'Usernames', widget: 'textarea', rows: 3 },
      },
      phones: {
        type: 'string',
        default: '',
        description: 'Comma- or newline-separated phone numbers granted the admin role.',
        'x-ui': { label: 'Phones', widget: 'textarea', rows: 3 },
      },
      userIds: {
        type: 'string',
        default: '',
        description: 'Comma- or newline-separated user IDs granted the admin role.',
        'x-ui': { label: 'User IDs', widget: 'textarea', rows: 3 },
      },
    },
  },
}

export const authSchemas = [authSchema, authAdminsSchema]



// ─── Build /auth/* route registrations ───
//
// Returns the full set of registrations to publish on plugin start.
// Each handler closes over `authenticator` and uses ask() to drive
// the internal authenticator actor.

export const buildAuthRoutes = (authenticator: ActorRef<HttpRequestMsg>): RouteRegistration[] => [
  {
    id: 'auth.register.options',
    method: 'GET',
    path: '/auth/register/options',
    target: authenticator,
  },
  {
    id: 'auth.register.status',
    method: 'GET',
    path: '/auth/register/status',
    target: authenticator,
  },
  {
    id: 'auth.register.begin',
    method: 'POST',
    path: '/auth/register/begin',
    target: authenticator,
  },
  {
    id: 'auth.register.finish',
    method: 'POST',
    path: '/auth/register/finish',
    target: authenticator,
  },
  {
    id: 'auth.login.begin',
    method: 'POST',
    path: '/auth/login/begin',
    target: authenticator,
  },
  {
    id: 'auth.login.options',
    method: 'GET',
    path: '/auth/login/options',
    target: authenticator,
  },
  {
    id: 'auth.login.finish',
    method: 'POST',
    path: '/auth/login/finish',
    target: authenticator,
  },
  {
    id: 'auth.login.status',
    method: 'GET',
    path: '/auth/login/status',
    target: authenticator,
  },
  {
    id: 'auth.ticket',
    method: 'POST',
    path: '/auth/ticket',
    target: authenticator,
  },
  {
    id: 'auth.logout',
    method: 'POST',
    path: '/auth/logout',
    target: authenticator,
  },
  {
    id: 'auth.profile.get',
    method: 'GET',
    path: '/auth/profile',
    target: authenticator,
  },
  {
    id: 'auth.profile.update',
    method: 'POST',
    path: '/auth/profile',
    target: authenticator,
  },
  {
    id: 'auth.static',
    method: 'GET',
    path: '/auth/',
    match: 'prefix',
    target: authenticator,
  },
]

