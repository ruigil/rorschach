import { RConfigPanel } from './r-config-panel.js'
import { store } from '@rorschach/webkit';
import type { PluginSummary } from '../types.ts';
import type { ConfigSchemaSection } from '../../../types/config.ts';

export { RConfigPanel }

export type ConfigUIState = {
  plugins: PluginSummary[]
  schemas: ConfigSchemaSection[]
  currentValues: Record<string, any>
  /** Last known server-side values per plugin — the baseline for dirty tracking. */
  initialValues: Record<string, any>
  /** Pending local edits: pluginId → { dottedConfigPath: value }. */
  dirtyFields: Record<string, Record<string, unknown>>
  loading: boolean
  error: string | null
  addInputPath: string
  isSubmitting: boolean
}

store.namespace<ConfigUIState>('config').init({
  plugins: [],
  schemas: [],
  currentValues: {},
  initialValues: {},
  dirtyFields: {},
  loading: false,
  error: null,
  addInputPath: '',
  isSubmitting: false,
})

/** Normalize the various list response envelopes ({ details }, { plugins },
 *  { schemas }, or a bare array) to a plain array. */
export const normalizeArray = (data: any): any[] =>
  Array.isArray(data) ? data : (data?.details ?? data?.plugins ?? data?.schemas ?? [])

export const refreshConfigPlugins = async () => {
  const ns = store.namespace<ConfigUIState>('config')
  ns.set('loading', true)
  try {
    const res = await fetch('/config/plugins')
    if (res.ok) {
      ns.set('plugins', normalizeArray(await res.json()))
      ns.set('error', null)
    } else {
      const text = await res.text()
      ns.set('error', `Failed to load plugins: ${res.status} ${text}`)
    }
  } catch (err) {
    ns.set('error', String(err))
  } finally {
    ns.set('loading', false)
  }
}

export const refreshConfigSchemas = async () => {
  const ns = store.namespace<ConfigUIState>('config')
  try {
    const res = await fetch('/config/schema')
    if (res.ok) {
      ns.set('schemas', normalizeArray(await res.json()))
    }
  } catch { /* schema refresh is best-effort */ }
}

/** Fetch values for any schema-bearing plugin not yet present in
 *  currentValues (e.g. a plugin loaded at runtime). Existing entries — and
 *  any pending local edits on them — are left untouched. */
export const syncMissingValues = async (): Promise<void> => {
  const ns = store.namespace<ConfigUIState>('config')
  const schemas = ns.get('schemas') ?? []
  const pluginIds = [...new Set(schemas.map(s => s.id.split('.')[0]))].filter((id): id is string => Boolean(id))
  for (const pid of pluginIds) {
    if (pid in (ns.get('currentValues') ?? {})) continue
    try {
      const res = await fetch(`/config/values/${pid}`)
      if (!res.ok) continue
      const data = await res.json()
      ns.set('currentValues', { ...ns.get('currentValues'), [pid]: data })
      ns.set('initialValues', { ...ns.get('initialValues'), [pid]: structuredClone(data) })
    } catch { /* per-plugin fetch is best-effort */ }
  }
}

/** Refetch one plugin's values after a config.updated frame. The change may
 *  have come from another writer (e.g. a config_set tool call), so the
 *  plugin is re-baselined: pending local edits on it are discarded (last
 *  writer wins). */
export const refreshConfigValues = async (pluginId: string): Promise<void> => {
  const ns = store.namespace<ConfigUIState>('config')
  try {
    const res = await fetch(`/config/values/${pluginId}`)
    if (!res.ok) return
    const data = await res.json()
    ns.set('currentValues', { ...ns.get('currentValues'), [pluginId]: data })
    ns.set('initialValues', { ...ns.get('initialValues'), [pluginId]: structuredClone(data) })
    const dirty = { ...ns.get('dirtyFields') }
    if (pluginId in dirty) {
      delete dirty[pluginId]
      ns.set('dirtyFields', dirty)
    }
  } catch { /* value refresh is best-effort */ }
}

export const reduceFrame = (frame: any) => {
  switch (frame?.type) {
    case 'config.schema':
      // Schema sections added/removed — refetch schemas and pull values for
      // any newly appeared plugin sections.
      refreshConfigSchemas().then(syncMissingValues)
      break
    case 'config.updated':
      if (frame.pluginId) refreshConfigValues(frame.pluginId)
      break
    case 'plugins.updated':
      refreshConfigPlugins()
      refreshConfigSchemas().then(syncMissingValues)
      break
    case 'plugin.health.changed':
      refreshConfigPlugins()
      break
  }
}

declare module '@rorschach/webkit/runtime/store.js' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface NamespaceRegistry {
    config: ConfigUIState
  }
}
