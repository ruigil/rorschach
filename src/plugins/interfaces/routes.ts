import type { RouteRegistration } from '../../types/routes.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import type { InterfacesConfig } from './interfaces.plugin.ts'

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
    },
  },
}

export const interfacesSchemas = [httpSchema, signalSchema]

// ─── Config Route ────────────────────────────────────────────────────────────

export const buildInterfacesConfigRoute = (getConfig: () => InterfacesConfig | undefined): RouteRegistration[] => [{
  id: 'config.interfaces',
  method: 'GET',
  path: '/config/interfaces',
  handler: () => {
    const slice = getConfig()
    return new Response(JSON.stringify(slice ?? {}), { headers: { 'Content-Type': 'application/json' } })
  },
}]
