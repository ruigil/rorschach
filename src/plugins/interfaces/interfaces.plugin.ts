import { createPluginFactory } from '../../system/index.ts'
import { HTTP } from './http.ts'
import { CLI } from './cli.ts'
import { Signal } from './signal.ts'
import { config, type InterfacesConfig } from './interfaces.config.ts'

export default createPluginFactory<InterfacesConfig>({
  id: 'interfaces',
  version: '1.0.0',
  description: 'External interfaces: HTTP server and WebSocket',
  configDescriptor: config,
  slots: {
    http: {
      factory: (cfg) => cfg ? HTTP(cfg) : null,
      configPath: 'http',
    },
    cli: {
      factory: (cfg) => cfg ? CLI() : null,
      configPath: 'cli',
    },
    signal: {
      factory: (cfg) => cfg ? Signal(cfg) : null,
      configPath: 'signal',
    },
  },
})
