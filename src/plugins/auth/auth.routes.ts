import type { ActorRef } from '../../system/index.ts'
import type { RouteRegistration, HttpRequestMsg } from '../../types/routes.ts'

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
    // public — WebAuthn registration flow
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
    auth: 'session',
  },
  {
    id: 'auth.logout',
    method: 'POST',
    path: '/auth/logout',
    target: authenticator,
    auth: 'session',
  },
  {
    id: 'auth.profile.get',
    method: 'GET',
    path: '/auth/profile',
    target: authenticator,
    auth: 'session',
  },
  {
    id: 'auth.profile.update',
    method: 'POST',
    path: '/auth/profile',
    target: authenticator,
    auth: 'session',
  },
  {
    id: 'auth.static',
    method: 'GET',
    path: '/auth/',
    match: 'prefix',
    target: authenticator,
    // public — login/register UI
  },
]

