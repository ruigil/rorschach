import type { ActorRef } from '../../system/index.ts'
import type { RouteRegistration, HttpRequestMsg } from '../../types/routes.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'

export const workflowsStorageSchema: ConfigSchemaSection = {
  id: 'workflows.storage',
  title: 'Workflows',
  subtitle: 'workflow storage and agent',
  tab: 'workflows',
  configKey: '',
  schema: {
    type: 'object',
    required: ['agent'],
    properties: {
      agent: {
        type: 'object',
        required: ['model', 'maxToolLoops'],
        properties: {
          model: { type: 'string', default: 'z-ai/glm-5.1', 'x-ui': { widget: 'model-select', label: 'Workflows model' } },
          maxToolLoops: { type: 'number', default: 10, minimum: 1, maximum: 50 },
          toolFilter: {
            type: 'object',
            oneOf: [
              {
                type: 'object',
                required: ['allow'],
                properties: { allow: { type: 'array', items: { type: 'string' } } },
                additionalProperties: false,
              },
              {
                type: 'object',
                required: ['deny'],
                properties: { deny: { type: 'array', items: { type: 'string' } } },
                additionalProperties: false,
              },
            ],
          },
        },
      },
    },
  },
}

export const workflowsSchemas = [workflowsStorageSchema]

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