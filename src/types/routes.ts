import { createTopic } from '../system/types.ts'

// ─── HTTP route registration ───
//
// Plugins contribute REST routes to the HTTP plugin without importing it.
// Mirrors the ToolRegistrationTopic pattern: publishers send registrations,
// the HTTP plugin maintains a dispatch table and tries registered routes
// before falling through to its inline handlers and static-file serving.
//
// `id` identifies the publisher's registration so it can be revoked
// (publish the same id with handler: null on plugin stop).

export type RouteHandler = (req: Request, url: URL) => Promise<Response> | Response

export type RouteMatch = 'exact' | 'prefix'

export type RouteRegistration =
  | { id: string; method: string; path: string; match?: RouteMatch; handler: RouteHandler }
  | { id: string; method: string; path: string; match?: RouteMatch; handler: null }   // unregister

export const RouteRegistrationTopic = createTopic<RouteRegistration>('http.route')
