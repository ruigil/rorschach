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

export type RouteMatch = 'exact' | 'prefix'

export type SerializedRequest = {
  method: string
  url: string
  headers: Record<string, string>
  body: string | Uint8Array | null
}

export type SerializedResponse = {
  status: number
  headers: Record<string, string>
  body: string | Uint8Array | null
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

export type RouteRegistration =
  | { id: string; method: string; path: string; match?: RouteMatch; target: ActorRef<HttpRequestMsg> }
  | { id: string; method: string; path: string; match?: RouteMatch; target: null }   // unregister

export const RouteRegistrationTopic = createTopic<RouteRegistration>('http.route')
