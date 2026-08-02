import { defineConfig } from '../../system/index.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'

// ─── Config type ────────────────────────────────────────────────────────────

export type ConfigPluginConfig = {
  /** Absolute or resolved path to config.json — required for desired-plane access. */
  configPath: string
}

// ─── Schema sections ────────────────────────────────────────────────────────

const configSchemas: ConfigSchemaSection[] = [
  {
    id: 'config.general',
    title: 'Configuration',
    subtitle: 'config · desired-plane file access',
    tab: 'config',
    configKey: '',
    schema: {
      type: 'object',
      properties: {
        configPath: {
          type: 'string',
          default: '',
          'x-ui': { label: 'Config file path' },
        },
      },
    },
  },
]

// ─── Defaults + descriptor ──────────────────────────────────────────────────

export const config = defineConfig<ConfigPluginConfig>('config', {
  configPath: '',
}, {
  schemas: configSchemas,
})