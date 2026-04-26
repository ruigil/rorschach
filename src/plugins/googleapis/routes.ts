import { google } from 'googleapis'
import type { RouteRegistration } from '../../types/routes.ts'
import { ask } from '../../system/ask.ts'
import { resolveIdentity } from '../../types/identity.ts'
import type { GoogleToken, OAuthStateMsg, SharedRefs } from './types.ts'

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
]

const closeWindowHtml = (message: string): Response =>
  new Response(
    `<!DOCTYPE html><html><body><p>${message}</p>` +
    `<script>window.close()</script></body></html>`,
    { headers: { 'Content-Type': 'text/html' } },
  )

const getCookieToken = (req: Request): string =>
  req.headers.get('cookie')?.split(';').reduce<string>((found, pair) => {
    const [k, v] = pair.trim().split('=')
    return k === 'session' ? (v ?? '') : found
  }, '') ?? ''

export const buildGoogleOAuthRoutes = (refs: SharedRefs): RouteRegistration[] => [
  {
    id:     'googleapis.auth.start',
    method: 'GET',
    path:   '/googleapis/auth/start',
    handler: async (req) => {
      const cookie   = getCookieToken(req)
      const identity = await resolveIdentity(refs.identityProviderRef, r => ({ type: 'resolveCookie', cookie, replyTo: r }))
      if (!identity) return new Response('Unauthorized', { status: 401 })

      if (!refs.oauthStateRef || !refs.clientId || !refs.clientSecret)
        return new Response('Google APIs not configured', { status: 503 })

      const state = await ask<OAuthStateMsg, string>(refs.oauthStateRef, r => ({
        type: 'createState' as const,
        userId: identity.userId,
        replyTo: r,
      }))

      const redirectUri = refs.baseUrl.replace(/\/$/, '') + '/googleapis/auth/callback'
      const oauth2      = new google.auth.OAuth2(refs.clientId, refs.clientSecret, redirectUri)
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

      if (!refs.oauthStateRef || !refs.tokenStoreRef || !refs.clientId || !refs.clientSecret)
        return closeWindowHtml('Google APIs not configured.')

      const userId = await ask<OAuthStateMsg, string | null>(refs.oauthStateRef, r => ({
        type: 'resolveState' as const,
        state,
        replyTo: r,
      }))

      if (!userId) return closeWindowHtml('Authorization failed: invalid or expired state.')

      try {
        const redirectUri = refs.baseUrl.replace(/\/$/, '') + '/googleapis/auth/callback'
        const oauth2      = new google.auth.OAuth2(refs.clientId, refs.clientSecret, redirectUri)
        const { tokens }  = await oauth2.getToken(code)
        refs.tokenStoreRef.send({ type: 'setToken', userId, token: tokens as GoogleToken })
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
    handler: async (req) => {
      const cookie   = getCookieToken(req)
      const identity = await resolveIdentity(refs.identityProviderRef, r => ({ type: 'resolveCookie', cookie, replyTo: r }))
      if (!identity) return new Response('Unauthorized', { status: 401 })

      if (!refs.tokenStoreRef)
        return new Response(JSON.stringify({ connected: false }), { headers: { 'Content-Type': 'application/json' } })

      const token = await ask(refs.tokenStoreRef, r => ({
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
    handler: async (req) => {
      const cookie   = getCookieToken(req)
      const identity = await resolveIdentity(refs.identityProviderRef, r => ({ type: 'resolveCookie', cookie, replyTo: r }))
      if (!identity) return new Response('Unauthorized', { status: 401 })

      refs.tokenStoreRef?.send({ type: 'deleteToken', userId: identity.userId })
      return new Response(null, { status: 200 })
    },
  },
]
