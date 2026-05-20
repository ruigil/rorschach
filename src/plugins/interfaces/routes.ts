import type { ConfigSchemaSection } from '../../types/config.ts'

// ─── Config Schema Sections ──────────────────────────────────────────────────

export const httpSchema: ConfigSchemaSection = {
  id: 'interfaces.http',
  title: 'HTTP',
  subtitle: 'interfaces · HTTP server and WebSocket',
  tab: 'interfaces',
  configKey: 'http',
  routeId: 'config.interfaces',
  schema: {
    type: 'object',
    properties: {
      port: { type: 'number', default: 3000, minimum: 1, maximum: 65535 },
    },
  },
}

export const signalSchema: ConfigSchemaSection = {
  id: 'interfaces.signal',
  title: 'Signal',
  subtitle: 'interfaces · TCP socket interface',
  tab: 'interfaces',
  configKey: 'signal',
  routeId: 'config.interfaces',
  schema: {
    type: 'object',
    properties: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'number', default: 7583, minimum: 1, maximum: 65535 },
      presenceTtlMs: { type: 'number', default: 3600000, minimum: 60000, description: 'Signal sender inactivity window before ending presence' },
    },
  },
}

export const interfacesSchemas = [httpSchema, signalSchema]
