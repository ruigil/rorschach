import { google } from 'googleapis'
import type { RouteRegistration } from '../../types/routes.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import { ask } from '../../system/index.ts'
import type { GoogleToken, GoogleOAuthRouteOpts, OAuthStateMsg } from './types.ts'

// ─── Config Schema Sections ──────────────────────────────────────────────────

export const googleapisSchema: ConfigSchemaSection = {
  id: 'googleapis.config',
  title: 'Google APIs',
  subtitle: 'googleapis · Gmail, Calendar, Drive, and YouTube',
  tab: 'googleapis',
  configKey: '',
  routeId: 'config.googleapis',
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

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/youtube.readonly',
]

const closeWindowHtml = (message: string): Response =>
  new Response(
    `<!DOCTYPE html><html><body><p>${message}</p>` +
    `<script>window.close()</script></body></html>`,
    { headers: { 'Content-Type': 'text/html' } },
  )

import type { ActorRef } from '../../system/index.ts'
import type { HttpRequestMsg } from '../../types/routes.ts'

export const buildGoogleOAuthRoutes = (oauthRouterRef: ActorRef<HttpRequestMsg>): RouteRegistration[] => [
  {
    id:     'googleapis.auth.start',
    method: 'GET',
    path:   '/googleapis/auth/start',
    target: oauthRouterRef,
  },
  {
    id:     'googleapis.auth.callback',
    method: 'GET',
    path:   '/googleapis/auth/callback',
    target: oauthRouterRef,
  },
  {
    id:     'googleapis.auth.status',
    method: 'GET',
    path:   '/googleapis/auth/status',
    target: oauthRouterRef,
  },
  {
    id:     'googleapis.auth.revoke',
    method: 'POST',
    path:   '/googleapis/auth/revoke',
    target: oauthRouterRef,
  },
]
