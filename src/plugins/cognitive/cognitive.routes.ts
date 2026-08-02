import type { ActorRef } from '../../system/index.ts'
import type { RouteRegistration, HttpRequestMsg } from '../../types/routes.ts'

export const buildCognitiveRoutes = (llmProviderRef?: ActorRef<HttpRequestMsg>): RouteRegistration[] => {
  if (!llmProviderRef) return []
  return [
    {
      id: 'cognitive.models',
      method: 'GET',
      path: '/models',
      target: llmProviderRef,
    }
  ]
}

