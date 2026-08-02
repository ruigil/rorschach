import { defineConfig } from '../../system/index.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'

// ─── Config type ────────────────────────────────────────────────────────────

export type GoogleApisConfig = {
  clientId?:     string
  clientSecret?: string
  baseUrl?:      string
  agentModel?:   string
  maxToolLoops?: number
}

// ─── Schema sections ────────────────────────────────────────────────────────

const googleapisSchema: ConfigSchemaSection = {
  id: 'googleapis.config',
  title: 'Google APIs',
  subtitle: 'googleapis · Gmail, Calendar, Drive, and YouTube',
  tab: 'googleapis',
  configKey: '',
  schema: {
    type: 'object',
    properties: {
      clientId: { type: 'string', 'x-ui': { secret: true, label: 'OAuth client ID' } },
      clientSecret: { type: 'string', 'x-ui': { secret: true, label: 'OAuth client secret' } },
      agentModel: { type: 'string', 'x-ui': { widget: 'model-select', label: 'Agent model' } },
      maxToolLoops: { type: 'number', default: 10, minimum: 1, maximum: 50 },
      _googleAccount: { type: 'string', 'x-ui': { widget: 'google-account' } },
    },
  },
}

const googleapisSchemas: ConfigSchemaSection[] = [googleapisSchema]

// ─── Defaults + descriptor ──────────────────────────────────────────────────

export const config = defineConfig<GoogleApisConfig>('googleapis', {
  clientId:     '',
  clientSecret: '',
  baseUrl:      '',
  agentModel:   'google/gemini-2.5-flash',
  maxToolLoops: 10,
}, {
  schemas: googleapisSchemas,
})