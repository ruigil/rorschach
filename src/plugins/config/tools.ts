import { defineTool } from '../../system/index.ts'

export const configGetTool = defineTool(
  'config_get',
  'Read desired configuration (raw config.json slice). Env placeholders like ${VAR} are returned as-is, not interpolated secrets.',
  {
    type: 'object',
    properties: {
      pluginId: {
        type: 'string',
        description: 'Optional plugin ID to filter config parameters. Omit to retrieve full desired config tree.',
      },
    },
  },
)

export const configSetTool = defineTool(
  'config_set',
  'Accept a config patch into desired state. Returns { accepted, revision }; actual apply is async via node-control converge.',
  {
    type: 'object',
    properties: {
      pluginId: {
        type: 'string',
        description: 'ID of the target plugin to configure.',
      },
      patch: {
        type: 'object',
        description: 'JSON object containing updated configuration key-value pairs.',
      },
    },
    required: ['pluginId', 'patch'],
  },
)

export const pluginsLoadTool = defineTool(
  'plugins_load',
  'Add a plugin module path to desired state. Returns { accepted, revision }; load happens on converge.',
  {
    type: 'object',
    properties: {
      modulePath: {
        type: 'string',
        description: 'Relative path or module specifier/path of the plugin to load.',
      },
    },
    required: ['modulePath'],
  },
)

export const pluginsUnloadTool = defineTool(
  'plugins_unload',
  'Remove a plugin from desired state by ID. Returns { accepted, revision }; unload happens on converge.',
  {
    type: 'object',
    properties: {
      pluginId: {
        type: 'string',
        description: 'ID of the plugin to unload.',
      },
    },
    required: ['pluginId'],
  },
)

export const pluginsReloadTool = defineTool(
  'plugins_reload',
  'Request a plugin reload by bumping reloadNonce in desired state. Returns { accepted, revision }.',
  {
    type: 'object',
    properties: {
      pluginId: {
        type: 'string',
        description: 'ID of the plugin to reload.',
      },
    },
    required: ['pluginId'],
  },
)
