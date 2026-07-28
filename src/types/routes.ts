import { createTopic } from '../system/index.ts'
import type { ActorRef } from '../system/index.ts'
import type { Identity } from './identity.ts'

// ─── HTTP route registration ───
//
// Plugins contribute REST routes to the HTTP plugin without importing it.
// Mirrors the ToolRegistrationTopic pattern: publishers send registrations,
// the HTTP plugin maintains a dispatch table and tries registered routes
// before falling through to its inline handlers and static-file serving.
//
// `id` identifies the publisher's registration so it can be revoked
// (publish the same id with target: null on plugin stop).
//
// Optional `auth` / `sameOrigin` are evaluated by the HTTP gateway before
// dispatch — plugins declare policy next to path/method; the interfaces
// domain does not hardcode path-based auth rules.

export type RouteMatch = 'exact' | 'prefix'

/** Gateway gate applied before dispatching to the target actor. Default: 'public'. */
export type RouteAuth =
  | 'public'   // no auth gate; identity still resolved and attached
  | 'session'  // require non-null identity (ANONYMOUS ok when provider unloaded)
  | 'admin'    // canAccessAdminSurface(provider, roles); null identity → 401

/**
 * CSRF Origin check.
 * - false / omitted: no check
 * - true: always require same-origin
 * - 'non-GET': require same-origin for methods other than GET/HEAD/OPTIONS
 */
export type RouteSameOrigin = boolean | 'non-GET'

export type SerializedRequest = {
  method: string
  url: string
  headers: Record<string, string>
  body: string | Uint8Array | null
}

export type SerializedResponse = {
  status: number
  headers: Record<string, string>
  body: string | Uint8Array | ReadableStream<Uint8Array> | null
}

export type HttpRequestMsg = {
  type: 'http.request'
  request: SerializedRequest
  identity: Identity | null
  replyTo: ActorRef<HttpResponseMsg>
}

export type HttpResponseMsg = {
  type: 'http.response'
  response: SerializedResponse
}

export type RouteRegistration = {
  id: string
  method: string
  path: string
  match?: RouteMatch
  /** Handler actor, or null to unregister this id. */
  target: ActorRef<HttpRequestMsg> | null
  /** Authorization gate applied by the HTTP gateway before dispatch. Default: 'public'. */
  auth?: RouteAuth
  /** CSRF protection via Origin check. Default: false. Common: 'non-GET' with auth: 'admin'. */
  sameOrigin?: RouteSameOrigin
}

export const RouteRegistrationTopic = createTopic<RouteRegistration>('http.route')
