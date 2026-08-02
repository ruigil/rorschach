import { defineConfig } from '../../system/index.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'

// ─── Config type ────────────────────────────────────────────────────────────

export type AuthConfig = {
  rpId:           string
  rpName:         string
  origin:         string
  baseUrl:        string
  sessionTtlMs:   number
  challengeTtlMs: number
  ticketTtlMs:    number
  admins?: {
    usernames?: string[] | string
    phones?:    string[] | string
    userIds?:   string[] | string
  }
  permissions?: {
    roleDefaults: Record<string, string[]>
  }
}

// ─── Schema sections ────────────────────────────────────────────────────────

const authSchema: ConfigSchemaSection = {
  id: 'auth.config',
  title: 'Authentication',
  subtitle: 'auth · WebAuthn and session settings',
  tab: 'auth',
  configKey: '',
  schema: {
    type: 'object',
    properties: {
      rpId: { type: 'string', default: 'localhost', 'x-ui': { label: 'Relying party ID' } },
      rpName: { type: 'string', default: 'Rorschach', 'x-ui': { label: 'Relying party name' } },
      origin: { type: 'string', default: 'http://localhost:3000', 'x-ui': { label: 'Origin URL' } },
      baseUrl: { type: 'string', default: 'http://localhost:3000', 'x-ui': { label: 'Base URL' } },
    },
  },
}

const authAdminsSchema: ConfigSchemaSection = {
  id: 'auth.admins',
  title: 'Admins',
  subtitle: 'auth · privileged runtime configuration access',
  tab: 'auth',
  configKey: 'admins',
  schema: {
    type: 'object',
    properties: {
      usernames: {
        type: 'string',
        default: '',
        description: 'Comma- or newline-separated usernames granted the admin role.',
        'x-ui': { label: 'Usernames', widget: 'textarea', rows: 3 },
      },
      phones: {
        type: 'string',
        default: '',
        description: 'Comma- or newline-separated phone numbers granted the admin role.',
        'x-ui': { label: 'Phones', widget: 'textarea', rows: 3 },
      },
      userIds: {
        type: 'string',
        default: '',
        description: 'Comma- or newline-separated user IDs granted the admin role.',
        'x-ui': { label: 'User IDs', widget: 'textarea', rows: 3 },
      },
    },
  },
}

const authSchemas: ConfigSchemaSection[] = [authSchema, authAdminsSchema]

// ─── Defaults + descriptor ──────────────────────────────────────────────────

const authDefaultConfig: AuthConfig = {
  rpId:           'localhost',
  rpName:         'Rorschach',
  origin:         'http://localhost:3000',
  baseUrl:        'http://localhost:3000',
  sessionTtlMs:   7 * 24 * 60 * 60 * 1000,
  challengeTtlMs: 5 * 60 * 1000,
  ticketTtlMs:    30 * 1000,
  admins:         {},
}

export const config = defineConfig<AuthConfig>('auth', authDefaultConfig, {
  schemas: authSchemas,
})