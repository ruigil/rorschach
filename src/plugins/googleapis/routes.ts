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

export const buildGoogleOAuthRoutes = (opts: GoogleOAuthRouteOpts): RouteRegistration[] => [
  {
    id:     'googleapis.auth.start',
    method: 'GET',
    path:   '/googleapis/auth/start',
    handler: async (_req, _url, identity) => {
      if (!identity) return new Response('Unauthorized', { status: 401 })

      if (!opts.oauthStateRef || !opts.clientId || !opts.clientSecret)
        return new Response('Google APIs not configured', { status: 503 })

      const state = await ask<OAuthStateMsg, string>(opts.oauthStateRef, r => ({
        type: 'createState' as const,
        userId: identity.userId,
        replyTo: r,
      }))

      const redirectUri = opts.baseUrl.replace(/\/$/, '') + '/googleapis/auth/callback'
      const oauth2      = new google.auth.OAuth2(opts.clientId, opts.clientSecret, redirectUri)
      const authUrl     = oauth2.generateAuthUrl({ access_type: 'offline', scope: SCOPES, state, prompt: 'consent' })

      return new Response(null, { status: 302, headers: { Location: authUrl } })
    },
  },

  {
    id:     'googleapis.auth.callback',
    method: 'GET',
    path:   '/googleapis/auth/callback',
    handler: async (_req, url) => {
      const code  = url.searchParams.get('code')
      const state = url.searchParams.get('state')

      if (!code || !state)
        return closeWindowHtml('Authorization failed: missing parameters.')

      if (!opts.oauthStateRef || !opts.tokenStoreRef || !opts.clientId || !opts.clientSecret)
        return closeWindowHtml('Google APIs not configured.')

      const userId = await ask<OAuthStateMsg, string | null>(opts.oauthStateRef, r => ({
        type: 'resolveState' as const,
        state,
        replyTo: r,
      }))

      if (!userId) return closeWindowHtml('Authorization failed: invalid or expired state.')

      try {
        const redirectUri = opts.baseUrl.replace(/\/$/, '') + '/googleapis/auth/callback'
        const oauth2      = new google.auth.OAuth2(opts.clientId, opts.clientSecret, redirectUri)
        const { tokens }  = await oauth2.getToken(code)
        opts.tokenStoreRef.send({ type: 'setToken', userId, token: tokens as GoogleToken })
        return closeWindowHtml('Connected! You can close this window.')
      } catch (err) {
        return closeWindowHtml(`Authorization failed: ${String(err)}`)
      }
    },
  },

  {
    id:     'googleapis.auth.status',
    method: 'GET',
    path:   '/googleapis/auth/status',
    handler: async (_req, _url, identity) => {
      if (!identity) return new Response('Unauthorized', { status: 401 })

      if (!opts.tokenStoreRef)
        return new Response(JSON.stringify({ connected: false }), { headers: { 'Content-Type': 'application/json' } })

      const token = await ask(opts.tokenStoreRef, r => ({
        type: 'getToken' as const,
        userId: identity.userId,
        replyTo: r,
      }))

      return new Response(JSON.stringify({ connected: token !== null }), {
        headers: { 'Content-Type': 'application/json' },
      })
    },
  },

  {
    id:     'googleapis.auth.revoke',
    method: 'POST',
    path:   '/googleapis/auth/revoke',
    handler: async (_req, _url, identity) => {
      if (!identity) return new Response('Unauthorized', { status: 401 })

      opts.tokenStoreRef?.send({ type: 'deleteToken', userId: identity.userId })
      return new Response(null, { status: 200 })
    },
  },
]
