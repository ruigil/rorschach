import { defineTool } from '../../system/index.ts'

export const configGetTool = defineTool(
  'config_get',
  'View active configuration parameters for the system or a specific plugin.',
  {
    type: 'object',
    properties: {
      pluginId: {
        type: 'string',
        description: 'Optional plugin ID to filter config parameters. Omit to retrieve full system config.',
      },
    },
  },
)

export const configSetTool = defineTool(
  'config_set',
  'Update configuration parameters for a specific plugin.',
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
  'Load and register a new plugin specifier into the running system.',
  {
    type: 'object',
    properties: {
      specifier: {
        type: 'string',
        description: 'Relative path or module specifier of the plugin to load.',
      },
    },
    required: ['specifier'],
  },
)

export const pluginsUnloadTool = defineTool(
  'plugins_unload',
  'Unload and unregister an active plugin by its ID.',
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
  'Hot-reload an active plugin by its ID.',
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
