
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

import { createTopic } from '../system/actor/types.ts'
import type { ObservedState } from '../system/node/types.ts'

export type ConfigSchemaEvent = {
  type: 'config.schema'
  key: string
  payload: { section: ConfigSchemaSection }
  isTombstone?: boolean
}

export const ConfigSchemaTopic = createTopic<ConfigSchemaEvent>('config.schema')

// ─── Observed plane (node-control sole writer; retained; key = systemId) ─────
//
// Phase 3: revision / appliedRevision + plugins. No live config tree (secrets).
// revision !== appliedRevision ⇒ converging or degraded.

export type SystemConfigObservedEvent = ObservedState

export const SystemConfigObservedTopic = createTopic<SystemConfigObservedEvent>('system.config.observed')
