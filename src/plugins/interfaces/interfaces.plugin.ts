import { createPluginFactory } from '../../system/index.ts'
import { HTTP, type HTTPOptions } from './http.ts'
import { CLI } from './cli.ts'
import { Signal, type SignalOptions } from './signal.ts'
import { defineConfig } from '../../system/index.ts'
import { interfacesSchemas } from './routes.ts'

export type InterfacesConfig = {
  http?:   HTTPOptions
  cli?:    Record<string, never>
  signal?: SignalOptions
}

const config = defineConfig<InterfacesConfig>('interfaces', {}, {
  schemas: interfacesSchemas,
})

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
