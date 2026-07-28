import type { RouteRegistration } from '../../types/routes.ts'
import type { ActorRef } from '../../system/index.ts'
import type { HttpRequestMsg } from '../../types/routes.ts'

export const buildConfigRoutes = (managerRef: ActorRef<HttpRequestMsg>): RouteRegistration[] => [
  { id: 'config.get', method: 'GET', path: '/config', match: 'exact', target: managerRef },
  { id: 'config.schema', method: 'GET', path: '/config/schema', match: 'exact', target: managerRef },
  { id: 'config.get-values', method: 'GET', path: '/config/values/', match: 'prefix', target: managerRef },
  { id: 'config.patch-values', method: 'PATCH', path: '/config/values/', match: 'prefix', target: managerRef },
  { id: 'config.plugins-list', method: 'GET', path: '/config/plugins', match: 'exact', target: managerRef },
  { id: 'config.plugins-add', method: 'POST', path: '/config/plugins/add', match: 'exact', target: managerRef },
  { id: 'config.plugins-remove', method: 'POST', path: '/config/plugins/remove', match: 'exact', target: managerRef },
  { id: 'config.plugins-reload', method: 'POST', path: '/config/plugins/reload', match: 'exact', target: managerRef },
]
