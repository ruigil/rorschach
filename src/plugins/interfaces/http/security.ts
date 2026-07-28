import type { ActorRef } from '../../../system/index.ts'
import type { IdentityProviderMsg, Identity } from '../../../types/identity.ts'
import type { RouteAuth, RouteSameOrigin } from '../../../types/routes.ts'

const hasAdminRole = (roles: readonly string[]): boolean =>
  roles.includes('admin')

export const canAccessAdminSurface = (
  identityProviderRef: ActorRef<IdentityProviderMsg> | null,
  roles: readonly string[],
): boolean =>
  identityProviderRef === null || hasAdminRole(roles)

export const isSameOriginRequest = (req: Request, url: URL): boolean => {
  const origin = req.headers.get('origin')
  if (!origin) return true
  const allowedOrigins = new Set([url.origin])

  const addHostOrigins = (host: string | undefined | null, proto?: string | null) => {
    const normalizedHost = host?.split(',')[0]?.trim()
    if (!normalizedHost) return
    const schemes = proto ? [proto] : [url.protocol.slice(0, -1), 'https']
    for (const scheme of schemes) {
      try {
        allowedOrigins.add(new URL(`${scheme}://${normalizedHost}`).origin)
      } catch { /* ignore malformed host headers */ }
    }
  }

  addHostOrigins(req.headers.get('host'))

  const forwardedHost = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  addHostOrigins(forwardedHost, forwardedProto)

  const forwarded = req.headers.get('forwarded')?.split(',')[0]
  if (forwarded) {
    const parts = Object.fromEntries(
      forwarded.split(';').map(part => {
        const [key, value] = part.split('=')
        return [key?.trim().toLowerCase(), value?.trim().replace(/^"|"$/g, '')]
      }).filter(([key, value]) => key && value),
    )
    if (parts.host && parts.proto) {
      addHostOrigins(parts.host, parts.proto)
    }
  }

  try {
    return allowedOrigins.has(new URL(origin).origin)
  } catch {
    return false
  }
}

export type RouteAuthPolicy = {
  auth?: RouteAuth
  sameOrigin?: RouteSameOrigin
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Returns a deny Response, or null if allowed. Path-agnostic route policy evaluation. */
export const authorizeRouteAccess = (
  identityProviderRef: ActorRef<IdentityProviderMsg> | null,
  req: Request,
  url: URL,
  identity: Identity | null,
  policy: RouteAuthPolicy,
): Response | null => {
  const auth = policy.auth ?? 'public'
  const sameOrigin = policy.sameOrigin ?? false

  const needsOrigin =
    sameOrigin === true ||
    (sameOrigin === 'non-GET' && !SAFE_METHODS.has(req.method.toUpperCase()))

  if (needsOrigin && !isSameOriginRequest(req, url)) {
    return new Response('Forbidden', { status: 403 })
  }

  if (auth === 'public') return null

  if (!identity) return new Response('Unauthorized', { status: 401 })

  if (auth === 'admin' && !canAccessAdminSurface(identityProviderRef, identity.roles)) {
    return new Response('Forbidden', { status: 403 })
  }

  // auth === 'session' (and admin with identity that passed role check)
  return null
}
