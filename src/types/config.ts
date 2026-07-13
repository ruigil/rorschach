
// ─── Config Schema Section ───────────────────────────────────────────────────
//
// Each plugin publishes one or more sections describing its configurable fields.
// The HTTP actor aggregates them and serves GET /config/schema.
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
  routeId: string
}


