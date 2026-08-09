import { createPluginFactory, SCRGCSweeper } from '../../system/index.ts'
import { SCRRegistry } from './registry-actor.ts'
import { RegistryMetaToolsActor } from './meta-tools.ts'
import { config, type RegistryConfig } from './registry.config.ts'

export default createPluginFactory<RegistryConfig>({
  id: 'registry',
  version: '1.0.0',
  description: 'Capability Registry: coordinates dynamic URN discovery and resolution',
  configDescriptor: config,
  slots: {
    registry: {
      factory: () => SCRRegistry(),
    },
    metaTools: {
      factory: () => RegistryMetaToolsActor(),
    },
    gcSweeper: {
      factory: () => SCRGCSweeper(),
    },
  },
  tools: {
    search: {
      schema: {
        type: 'function',
        function: {
          name: 'registry_search',
          description: 'Search for registered capabilities by query matching URN, kind, tags, and description.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search term' }
            }
          }
        }
      },
      slot: 'metaTools',
    },
    get: {
      schema: {
        type: 'function',
        function: {
          name: 'registry_get',
          description: 'Retrieve details of a registered capability by URN.',
          parameters: {
            type: 'object',
            properties: {
              urn: { type: 'string', description: 'Exact URN' }
            },
            required: ['urn']
          }
        }
      },
      slot: 'metaTools',
    }
  }
})
