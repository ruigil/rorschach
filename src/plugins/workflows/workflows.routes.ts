import type { ActorRef } from '../../system/index.ts'
import type { RouteRegistration, HttpRequestMsg } from '../../types/routes.ts'

export const buildWorkflowsRoutes = (
  workflowManagerRef: ActorRef<HttpRequestMsg> | null,
): RouteRegistration[] => {
  if (!workflowManagerRef) return []
  return [
    {
      id: 'workflow-runs.artifact',
      method: 'GET',
      path: '/artifact',
      match: 'exact',
      target: workflowManagerRef,
      auth: 'session',
    },
  ]
}