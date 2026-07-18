import { google } from 'googleapis'
import { ask, onMessage, type ActorDef, type ActorRef, type ActorContext } from '../../system/index.ts'
import type { OAuthStateMsg, TokenStoreMsg, GoogleToken } from './types.ts'
import type { HttpRequestMsg, HttpResponseMsg } from '../../types/routes.ts'

export type OAuthRouterMsg =
  | HttpRequestMsg
  | { type: 'noop' }

export type OAuthRouterOptions = {
  tokenStore: ActorRef<TokenStoreMsg>
  oauthState: ActorRef<OAuthStateMsg>
  clientId: string
  clientSecret: string
  baseUrl: string
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/youtube.readonly',
]

const closeWindowHtml = (message: string) => ({
  status: 200,
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
  body: `<!DOCTYPE html><html><body><p>${message}</p><script>window.close()</script></body></html>`
})

export const OAuthRouter = (opts: OAuthRouterOptions): ActorDef<OAuthRouterMsg, null> => {
  const { tokenStore, oauthState, clientId, clientSecret, baseUrl } = opts

  type RequestContext = {
    url: URL
    request: any
    identity: any
    replyTo: any
    ctx: ActorContext<OAuthRouterMsg>
    jsonResponse: (body: any, status?: number) => void
  }

  const handlers: Record<string, Record<string, (rc: RequestContext) => void>> = {
    GET: {
      '/googleapis/auth/start': ({ identity, replyTo, ctx }) => {
        if (!identity) {
          replyTo.send({ type: 'http.response', response: { status: 401, headers: {}, body: 'Unauthorized' } })
          return
        }
        if (!clientId || !clientSecret) {
          replyTo.send({ type: 'http.response', response: { status: 503, headers: {}, body: 'Google APIs not configured' } })
          return
        }

        ctx.pipeToSelf(
          (async () => {
            const stateToken = await ask<OAuthStateMsg, string>(oauthState, r => ({
              type: 'createState' as const,
              userId: identity.userId,
              replyTo: r,
            }))
            const redirectUri = baseUrl.replace(/\/$/, '') + '/googleapis/auth/callback'
            const oauth2      = new google.auth.OAuth2(clientId, clientSecret, redirectUri)
            const authUrl     = oauth2.generateAuthUrl({ access_type: 'offline', scope: SCOPES, state: stateToken, prompt: 'consent' })
            return authUrl
          })(),
          (authUrl) => {
            replyTo.send({
              type: 'http.response',
              response: {
                status: 302,
                headers: { Location: authUrl as string },
                body: null,
              }
            })
            return { type: 'noop' as const }
          },
          (err) => {
            replyTo.send({
              type: 'http.response',
              response: { status: 500, headers: {}, body: String(err) }
            })
            return { type: 'noop' as const }
          }
        )
      },

      '/googleapis/auth/callback': ({ url, replyTo, ctx }) => {
        const code  = url.searchParams.get('code')
        const stateToken = url.searchParams.get('state')

        if (!code || !stateToken) {
          replyTo.send({ type: 'http.response', response: closeWindowHtml('Authorization failed: missing parameters.') })
          return
        }
        if (!clientId || !clientSecret) {
          replyTo.send({ type: 'http.response', response: closeWindowHtml('Google APIs not configured.') })
          return
        }

        ctx.pipeToSelf(
          (async () => {
            const userId = await ask<OAuthStateMsg, string | null>(oauthState, r => ({
              type: 'resolveState' as const,
              state: stateToken,
              replyTo: r,
            }))
            if (!userId) throw new Error('Authorization failed: invalid or expired state.')

            const redirectUri = baseUrl.replace(/\/$/, '') + '/googleapis/auth/callback'
            const oauth2      = new google.auth.OAuth2(clientId, clientSecret, redirectUri)
            const { tokens }  = await oauth2.getToken(code)
            tokenStore.send({ type: 'setToken' as const, userId, token: tokens as GoogleToken })
            return 'Connected! You can close this window.'
          })(),
          (msg) => {
            replyTo.send({ type: 'http.response', response: closeWindowHtml(msg as string) })
            return { type: 'noop' as const }
          },
          (err) => {
            replyTo.send({ type: 'http.response', response: closeWindowHtml(String(err)) })
            return { type: 'noop' as const }
          }
        )
      },

      '/googleapis/auth/status': ({ identity, replyTo, ctx, jsonResponse }) => {
        if (!identity) {
          replyTo.send({ type: 'http.response', response: { status: 401, headers: {}, body: 'Unauthorized' } })
          return
        }

        ctx.pipeToSelf(
          (async () => {
            const token = await ask(tokenStore, r => ({
              type: 'getToken' as const,
              userId: identity.userId,
              replyTo: r,
            }))
            return token !== null
          })(),
          (connected) => {
            jsonResponse({ connected })
            return { type: 'noop' as const }
          },
          () => {
            jsonResponse({ connected: false })
            return { type: 'noop' as const }
          }
        )
      }
    },
    POST: {
      '/googleapis/auth/revoke': ({ identity, replyTo }) => {
        if (!identity) {
          replyTo.send({ type: 'http.response', response: { status: 401, headers: {}, body: 'Unauthorized' } })
          return
        }

        tokenStore.send({ type: 'deleteToken' as const, userId: identity.userId })
        replyTo.send({
          type: 'http.response',
          response: {
            status: 200,
            headers: {},
            body: null,
          }
        })
      }
    }
  }

  return {
    initialState: null,
    handler: onMessage<OAuthRouterMsg, null>({
      'http.request': (state, message, ctx) => {
        const { request, identity, replyTo } = message
        const url = new URL(request.url, 'http://localhost')
        const path = url.pathname

        const jsonResponse = (body: any, status = 200) => {
          replyTo.send({
            type: 'http.response',
            response: {
              status,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }
          })
        }

        const handler = handlers[request.method]?.[path]
        if (handler) {
          handler({ url, request, identity, replyTo, ctx, jsonResponse })
          return { state }
        }

        replyTo.send({ type: 'http.response', response: { status: 404, headers: {}, body: 'Not Found' } })
        return { state }
      },

      noop: (state: null) => ({ state }),
    })
  }
}
