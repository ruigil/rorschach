import type { RouteRegistration } from '../../types/routes.ts'
import type { ActorRef } from '../../system/index.ts'
import type { HttpRequestMsg } from '../../types/routes.ts'

export const buildCodingRoutes = (pageToolsRef: ActorRef<HttpRequestMsg>): RouteRegistration[] => [
  {
    id: 'coding.documentation',
    method: 'GET',
    path: '/documentation/',
    match: 'prefix',
    target: pageToolsRef,
    auth: 'session',
  },
]
