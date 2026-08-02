import { createPluginFactory, defineConfig } from '../../system/index.ts'
import type { UiSurfaceRegistration } from '../../types/ui-surface.ts'
import { buildConfigRoutes } from './routes.ts'
import { configGetTool, configSetTool, pluginsLoadTool, pluginsUnloadTool, pluginsReloadTool } from './tools.ts'
import { ConfigActor } from './manager.ts'
import type { ConfigPluginConfig } from './types.ts'

const config = defineConfig<ConfigPluginConfig>('config', {
  configPath: '',
})

const configSurfaceRegistration: UiSurfaceRegistration = {
  id: 'config',
  version: '1.0.0',
  view: {
    title: 'Configuration',
    icon: 'settings',
    contentTag: 'r-config-panel',
  },
  moduleUrl: '/js/plugins/config.js',
  frameTypes: ['config.schema', 'config.updated', 'plugins.updated', 'plugin.health.changed'],
}

export default createPluginFactory<ConfigPluginConfig>({
  id: 'config',
  version: '1.0.0',
  description: 'Unified Configuration & Plugin Management',
  configDescriptor: config,
  uiSurface: configSurfaceRegistration,
  slots: {
    manager: {
      factory: (cfg: ConfigPluginConfig) => ConfigActor(cfg),
      surviveConfigChange: true,
    },
  },
  routes: (_cfg, deps) => buildConfigRoutes(deps.manager as any),
  tools: {
    config_get: { schema: configGetTool.schema, slot: 'manager' },
    config_set: { schema: configSetTool.schema, slot: 'manager' },
    plugins_load: { schema: pluginsLoadTool.schema, slot: 'manager' },
    plugins_unload: { schema: pluginsUnloadTool.schema, slot: 'manager' },
    plugins_reload: { schema: pluginsReloadTool.schema, slot: 'manager' },
  },
})
