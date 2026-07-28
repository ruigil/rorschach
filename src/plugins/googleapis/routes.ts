import type { RouteRegistration, HttpRequestMsg } from '../../types/routes.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import type { ActorRef } from '../../system/index.ts'

// ─── Config Schema Sections ──────────────────────────────────────────────────

export const googleapisSchema: ConfigSchemaSection = {
  id: 'googleapis.config',
  title: 'Google APIs',
  subtitle: 'googleapis · Gmail, Calendar, Drive, and YouTube',
  tab: 'googleapis',
  configKey: '',
  schema: {
    type: 'object',
    properties: {
      agentModel: { type: 'string', 'x-ui': { widget: 'model-select', label: 'Agent model' } },
      maxToolLoops: { type: 'number', default: 10, minimum: 1, maximum: 50 },
      _googleAccount: { type: 'string', 'x-ui': { widget: 'google-account' } },
    },
  },
}

export const googleapisSchemas = [googleapisSchema]

export const buildGoogleOAuthRoutes = (oauthRouterRef: ActorRef<HttpRequestMsg>): RouteRegistration[] => [
  {
    id:     'googleapis.auth.start',
    method: 'GET',
    path:   '/googleapis/auth/start',
    target: oauthRouterRef,
    auth:   'session',
  },
  {
    id:     'googleapis.auth.callback',
    method: 'GET',
    path:   '/googleapis/auth/callback',
    target: oauthRouterRef,
    // public — OAuth redirect; state token binds the user
  },
  {
    id:     'googleapis.auth.status',
    method: 'GET',
    path:   '/googleapis/auth/status',
    target: oauthRouterRef,
    auth:   'session',
  },
  {
    id:     'googleapis.auth.revoke',
    method: 'POST',
    path:   '/googleapis/auth/revoke',
    target: oauthRouterRef,
    auth:   'session',
  },
]
