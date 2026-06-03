import type { RouteRegistration } from '../../types/routes.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'

// ─── Config Schema Sections ──────────────────────────────────────────────────

export const notebookSchema: ConfigSchemaSection = {
  id: 'notebook.config',
  title: 'Notebook',
  subtitle: 'notebook · journal, todos, and tracker',
  tab: 'notebook',
  configKey: '',
  routeId: 'config.notebook',
  schema: {
    type: 'object',
    properties: {
      notebookDir: { type: 'string', default: 'workspace/notebook', 'x-ui': { label: 'Notebook directory' } },
      agentModel: { type: 'string', 'x-ui': { widget: 'model-select', label: 'Agent model' } },
      maxToolLoops: { type: 'number', default: 10, minimum: 1, maximum: 50 },
    },
  },
}

export const notebookSchemas = [notebookSchema]

export const buildNotebookRoutes = (
  _notebookDir: string,
): RouteRegistration[] => [
]
