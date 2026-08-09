import { defineConfig } from '../../system/index.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'

export type RegistryConfig = Record<string, never>

const registrySchema: ConfigSchemaSection = {
  id: 'registry.general',
  title: 'Registry',
  subtitle: 'registry · core capability registration',
  tab: 'registry',
  configKey: '',
  schema: {
    type: 'object',
    properties: {},
  },
}

export const defaultConfig: RegistryConfig = {}

export const config = defineConfig<RegistryConfig>('registry', defaultConfig, {
  schemas: [registrySchema],
})
