
// ─── Config Schema Section ───────────────────────────────────────────────────
//
// Each plugin publishes one or more sections describing its configurable fields.
// The ConfigActor (config plugin manager slot) aggregates them, serves
// GET /config/schema, and republishes changes to the admin WS channel.
// The web UI renders dynamic forms from the JSON Schema.
//
// `schema` is a standard JSON Schema object. Plugins annotate fields with
// `x-ui` hints for custom rendering:
//   { widget: 'model-select' }  — model dropdown populated from /models
//   { widget: 'textarea', rows: 4 }  — multiline text input
//   { widget: 'toggle' }  — boolean toggle (also inferred from type: boolean)
//   { widget: 'text', secret: true }  — masked password input
//   { label: 'Display Name' }  — override the field key as label
//
// Standard JSON Schema `enum` maps to a <select> dropdown.
// When `x-ui` is absent, the renderer infers from `type`.

export type ConfigSchemaSection = {
  id: string
  title: string
  subtitle?: string
  tab: string
  configKey: string
  schema: Record<string, unknown> | null
}

import { createTopic, type ActorRef } from '../system/index.ts'

export { CORE_PLUGIN_IDS } from './core-plugins.ts'

export type ConfigSchemaEvent = {
  type: 'config.schema'
  key: string
  payload: { section: ConfigSchemaSection }
  isTombstone?: boolean
}

export const ConfigSchemaTopic = createTopic<ConfigSchemaEvent>('system.config.schema')

export type SystemConfigUpdateRequest =
  | { action: 'set_value'; pluginId: string; patch: Record<string, unknown>; replyTo?: ActorRef<any> }
  | { action: 'add_plugin'; specifier: string; replyTo?: ActorRef<any> }
  | { action: 'remove_plugin'; pluginId: string; replyTo?: ActorRef<any> }
  | { action: 'reload_plugin'; pluginId: string; replyTo?: ActorRef<any> }
  | { action: 'get_values'; pluginId?: string; replyTo?: ActorRef<any> }
  | { action: 'list_plugins'; replyTo?: ActorRef<any> }

export type SystemConfigUpdateResult =
  | { success: true; message?: string; details?: unknown }
  | { success: false; error: string }

export const SystemConfigUpdateTopic = createTopic<SystemConfigUpdateRequest>('system.config.update')
