import type { RouteRegistration, HttpRequestMsg } from '../../types/routes.ts'
import type { ActorRef } from '../../system/index.ts'

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
