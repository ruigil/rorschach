import { join, resolve, sep } from 'node:path'
import { type ActorDef, type ActorRef, onMessage, type ActorContext } from '../../system/index.ts'
import type { HttpRequestMsg, HttpResponseMsg, SerializedRequest } from '../../types/routes.ts'
import type { AuthenticatorMsg } from './types.ts'
import type { AuthConfig } from './authenticator.ts'

export type AuthenticatorRouterOptions = {
  authenticator: ActorRef<AuthenticatorMsg>
  config: AuthConfig
}

export const AuthenticatorRouter = (opts: AuthenticatorRouterOptions): ActorDef<HttpRequestMsg, null> => {
  const { authenticator, config } = opts

  const PLUGIN_PUBLIC_DIR = join(import.meta.dir, 'public')

  const staticMimeType = (path: string): string => {
    if (path.endsWith('.html')) return 'text/html; charset=utf-8'
    if (path.endsWith('.css')) return 'text/css; charset=utf-8'
    if (path.endsWith('.js')) return 'application/javascript; charset=utf-8'
    return 'application/octet-stream'
  }

  const safeJoinPluginPath = (pathname: string): string | null => {
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return null
    }
    const relativePath = decoded.startsWith('/auth') ? decoded.slice('/auth'.length) : decoded
    const base = resolve(PLUGIN_PUBLIC_DIR)
    const filePath = resolve(base, `.${relativePath}`)
    return filePath === base || filePath.startsWith(base + sep) ? filePath : null
  }

  const SESSION_MAX_AGE = 7 * 24 * 60 * 60   // 7 days
  const sessionCookie = (token: string): string =>
    `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}`

  const getCookieToken = (req: SerializedRequest): string | null => {
    const cookies = req.headers['cookie'] ?? ''
    return cookies.split(';').reduce<string | null>((found, pair) => {
      const [k, v] = pair.trim().split('=')
      return k === 'session' ? (v ?? null) : found
    }, null)
  }

  type RequestContext = {
    url: URL
    request: SerializedRequest
    identity: any
    replyTo: ActorRef<HttpResponseMsg>
    ctx: ActorContext<HttpRequestMsg>
    jsonResponse: (body: any, status?: number, headers?: Record<string, string>) => void
  }

  const handlers: Record<string, Record<string, (rc: RequestContext) => void>> = {
    GET: {
      '/auth/register/options': ({ url, replyTo, jsonResponse }) => {
        const challengeId = url.searchParams.get('challenge')
        if (!challengeId) {
          replyTo.send({ type: 'http.response', response: { status: 400, headers: {}, body: 'challenge required' } })
          return
        }
        authenticator.send({
          type: 'getRegOptions',
          challengeId,
          replyTo: {
            name: 'http:reg:options',
            isAlive: () => true,
            send: (res) => {
              if (!res) jsonResponse({ error: 'challenge not found or expired' }, 404)
              else jsonResponse(res)
            }
          }
        })
      },
      '/auth/register/status': ({ url, replyTo, jsonResponse }) => {
        const challengeId = url.searchParams.get('challenge')
        if (!challengeId) {
          replyTo.send({ type: 'http.response', response: { status: 400, headers: {}, body: 'challenge required' } })
          return
        }
        authenticator.send({
          type: 'pollRegistration',
          challengeId,
          replyTo: {
            name: 'http:reg:status',
            isAlive: () => true,
            send: (result) => {
              if ('error' in result) jsonResponse({ status: 'error', error: result.error }, 400)
              else if ('pending' in result) jsonResponse({ status: 'pending' })
              else jsonResponse({ status: 'fulfilled' }, 200, { 'Set-Cookie': sessionCookie(result.token) })
            }
          }
        })
      },
      '/auth/login/options': ({ url, replyTo, jsonResponse }) => {
        const challengeId = url.searchParams.get('challenge')
        if (!challengeId) {
          replyTo.send({ type: 'http.response', response: { status: 400, headers: {}, body: 'challenge required' } })
          return
        }
        authenticator.send({
          type: 'getAuthOptions',
          challengeId,
          replyTo: {
            name: 'http:login:options',
            isAlive: () => true,
            send: (res) => {
              if (!res) jsonResponse({ error: 'challenge not found or expired' }, 404)
              else jsonResponse(res)
            }
          }
        })
      },
      '/auth/login/status': ({ url, replyTo, jsonResponse }) => {
        const challengeId = url.searchParams.get('challenge')
        if (!challengeId) {
          replyTo.send({ type: 'http.response', response: { status: 400, headers: {}, body: 'challenge required' } })
          return
        }
        authenticator.send({
          type: 'pollChallenge',
          challengeId,
          replyTo: {
            name: 'http:login:status',
            isAlive: () => true,
            send: (result) => {
              if ('error' in result) jsonResponse({ status: 'error', error: result.error }, 400)
              else if ('pending' in result) jsonResponse({ status: 'pending' })
              else jsonResponse({ status: 'fulfilled' }, 200, { 'Set-Cookie': sessionCookie(result.token) })
            }
          }
        })
      },
      '/auth/profile': ({ identity, replyTo, jsonResponse }) => {
        if (!identity || identity.userId === 'anonymous') {
          replyTo.send({ type: 'http.response', response: { status: 401, headers: {}, body: 'Unauthorized' } })
          return
        }
        authenticator.send({
          type: 'getUserProfile',
          userId: identity.userId,
          replyTo: {
            name: 'http:profile:get',
            isAlive: () => true,
            send: (user) => {
              if (!user) jsonResponse({ error: 'user not found' }, 404)
              else jsonResponse({
                fullName: user.fullName,
                avatar: user.avatar || '',
                phone: user.phone || '',
                roles: identity.roles,
                timezone: user.timezone || '',
              })
            }
          }
        })
      }
    },
    POST: {
      '/auth/register/begin': ({ request, replyTo, jsonResponse }) => {
        try {
          const body = JSON.parse(request.body as string || '{}')
          if (!body.phone) {
            replyTo.send({ type: 'http.response', response: { status: 400, headers: {}, body: 'phone required' } })
            return
          }
          authenticator.send({
            type: 'beginRegistration',
            phone: body.phone,
            replyTo: {
              name: 'http:reg:begin',
              isAlive: () => true,
              send: (result) => {
                if ('error' in result) jsonResponse(result, 400)
                else jsonResponse(result)
              }
            }
          })
        } catch {
          replyTo.send({ type: 'http.response', response: { status: 400, headers: {}, body: 'Bad request' } })
        }
      },
      '/auth/register/finish': ({ request, replyTo, jsonResponse }) => {
        try {
          const body = JSON.parse(request.body as string || '{}')
          if (!body.challengeId || !body.credential) {
            replyTo.send({ type: 'http.response', response: { status: 400, headers: {}, body: 'missing fields' } })
            return
          }
          authenticator.send({
            type: 'finishRegistration',
            challengeId: body.challengeId,
            credential: body.credential,
            replyTo: {
              name: 'http:reg:finish',
              isAlive: () => true,
              send: (result) => {
                if ('error' in result) jsonResponse(result, 400)
                else jsonResponse({ ok: true }, 200, { 'Set-Cookie': sessionCookie(result.token) })
              }
            }
          })
        } catch {
          replyTo.send({ type: 'http.response', response: { status: 400, headers: {}, body: 'Bad request' } })
        }
      },
      '/auth/login/begin': ({ jsonResponse }) => {
        authenticator.send({
          type: 'beginAuthentication',
          replyTo: {
            name: 'http:login:begin',
            isAlive: () => true,
            send: (result) => {
              if ('error' in result) jsonResponse(result, 400)
              else jsonResponse(result)
            }
          }
        })
      },
      '/auth/login/finish': ({ request, replyTo, jsonResponse }) => {
        try {
          const body = JSON.parse(request.body as string || '{}')
          if (!body.challengeId || !body.credential) {
            replyTo.send({ type: 'http.response', response: { status: 400, headers: {}, body: 'missing fields' } })
            return
          }
          authenticator.send({
            type: 'finishAuthentication',
            challengeId: body.challengeId,
            credential: body.credential,
            replyTo: {
              name: 'http:login:finish',
              isAlive: () => true,
              send: (result) => {
                if ('error' in result) jsonResponse(result, 400)
                else jsonResponse({ ok: true }, 200, { 'Set-Cookie': sessionCookie(result.token) })
              }
            }
          })
        } catch {
          replyTo.send({ type: 'http.response', response: { status: 400, headers: {}, body: 'Bad request' } })
        }
      },
      '/auth/ticket': ({ request, identity, replyTo, jsonResponse }) => {
        if (!identity) {
          replyTo.send({ type: 'http.response', response: { status: 401, headers: {}, body: 'Unauthorized' } })
          return
        }
        const token = getCookieToken(request)
        if (!token) {
          replyTo.send({ type: 'http.response', response: { status: 401, headers: {}, body: 'Unauthorized' } })
          return
        }
        authenticator.send({
          type: 'issueTicket',
          token,
          replyTo: {
            name: 'http:ticket',
            isAlive: () => true,
            send: (result) => {
              if ('error' in result) replyTo.send({ type: 'http.response', response: { status: 401, headers: {}, body: 'Unauthorized' } })
              else jsonResponse(result)
            }
          }
        })
      },
      '/auth/logout': ({ request, replyTo }) => {
        const token = getCookieToken(request)
        if (token) authenticator.send({ type: 'revokeToken', token })
        replyTo.send({
          type: 'http.response',
          response: {
            status: 204,
            headers: { 'Set-Cookie': 'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' },
            body: null,
          }
        })
      },
      '/auth/profile': ({ request, identity, replyTo, jsonResponse }) => {
        if (!identity || identity.userId === 'anonymous') {
          replyTo.send({ type: 'http.response', response: { status: 401, headers: {}, body: 'Unauthorized' } })
          return
        }
        try {
          const body = JSON.parse(request.body as string || '{}')
          if (!body.fullName) {
            replyTo.send({ type: 'http.response', response: { status: 400, headers: {}, body: 'fullName required' } })
            return
          }
          authenticator.send({
            type: 'updateUserProfile',
            userId: identity.userId,
            fullName: body.fullName,
            avatar: body.avatar,
            timezone: body.timezone,
            replyTo: {
              name: 'http:profile:update',
              isAlive: () => true,
              send: (result) => {
                if ('error' in result) jsonResponse(result, 400)
                else jsonResponse({
                  ok: true,
                  user: {
                    fullName: result.ok.fullName,
                    avatar: result.ok.avatar || '',
                    phone: result.ok.phone || '',
                    roles: result.ok.roles,
                    timezone: result.ok.timezone || '',
                  }
                })
              }
            }
          })
        } catch {
          replyTo.send({ type: 'http.response', response: { status: 400, headers: {}, body: 'Bad request' } })
        }
      }
    }
  }

  const serveStaticFile = async (path: string, replyTo: ActorRef<HttpResponseMsg>): Promise<void> => {
    const filePath = path === '/auth/' || path === '/auth'
      ? join(PLUGIN_PUBLIC_DIR, 'login.html')
      : safeJoinPluginPath(path)

    if (!filePath) {
      replyTo.send({ type: 'http.response', response: { status: 404, headers: {}, body: 'Not Found' } })
      return
    }

    try {
      const file = Bun.file(filePath)
      if (await file.exists()) {
        const content = await file.text()
        replyTo.send({
          type: 'http.response',
          response: {
            status: 200,
            headers: { 'Content-Type': staticMimeType(filePath) },
            body: content,
          }
        })
      } else {
        replyTo.send({ type: 'http.response', response: { status: 404, headers: {}, body: 'Not Found' } })
      }
    } catch (err) {
      replyTo.send({ type: 'http.response', response: { status: 500, headers: {}, body: String(err) } })
    }
  }

  return {
    initialState: null,
    handler: onMessage<HttpRequestMsg, null>({
      'http.request': (state, message, ctx) => {
        const { request, identity, replyTo } = message
        const url = new URL(request.url, 'http://localhost')
        const path = url.pathname

        const jsonResponse = (body: any, status = 200, headers?: Record<string, string>) => {
          replyTo.send({
            type: 'http.response',
            response: {
              status,
              headers: { 'Content-Type': 'application/json', ...headers },
              body: JSON.stringify(body),
            }
          })
        }

        const handler = handlers[request.method]?.[path]
        if (handler) {
          handler({ url, request, identity, replyTo, ctx, jsonResponse })
          return { state }
        }

        // Static Login files serving fallback (Option A: Actor-assisted file reading)
        if (request.method === 'GET' && path.startsWith('/auth')) {
          serveStaticFile(path, replyTo)
          return { state }
        }

        replyTo.send({ type: 'http.response', response: { status: 404, headers: {}, body: 'Not Found' } })
        return { state }
      }
    })
  }
}
