import type { ActorRef } from '../../system/index.ts'
import type { RouteRegistration, HttpRequestMsg } from '../../types/routes.ts'

export const buildWorkflowsRoutes = (
  workflowRunnerRef: ActorRef<HttpRequestMsg> | null,
): RouteRegistration[] => {
  if (!workflowRunnerRef) return []
  return [
    {
      id: 'workflow-runs.artifact',
      method: 'GET',
      path: '/artifact',
      match: 'exact',
      target: workflowRunnerRef,
      auth: 'session',
    },
  ]
}