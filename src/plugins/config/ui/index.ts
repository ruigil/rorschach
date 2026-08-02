import { RConfigPanel } from './r-config-panel.js'
import { store } from '@rorschach/webkit';
import type { PluginSummary } from '../types.ts';
import type { ConfigSchemaSection } from '../../../types/config.ts';

export { RConfigPanel }

export type ConfigUIState = {
  /** System currently being edited/viewed (single source today → 'local'). */
  activeSystemId: string
  /** Observed systems, each with its plugins + revision lag (tree roots). */
  systems: SystemSummary[]
  plugins: PluginSummary[]
  schemas: ConfigSchemaSection[]
  currentValues: Record<string, any>
  /** Last known server-side desired values per plugin — baseline for dirty tracking. */
  initialValues: Record<string, any>
  /** Pending local edits: pluginId → { dottedConfigPath: value }. */
  dirtyFields: Record<string, Record<string, unknown>>
  loading: boolean
  error: string | null
  addInputPath: string
  isSubmitting: boolean
  /** Desired revision last accepted by a mutation (content hash). */
  pendingRevision: string | null
  /** Last observed desired revision from node-control. */
  observedRevision: string | null
  /** Last fully applied revision from node-control. */
  appliedRevision: string | null
}

store.namespace<ConfigUIState>('config').init({
  activeSystemId: 'local',
  systems: [],
  plugins: [],
  schemas: [],
  currentValues: {},
  initialValues: {},
  dirtyFields: {},
  loading: false,
  error: null,
  addInputPath: '',
  isSubmitting: false,
  pendingRevision: null,
  observedRevision: null,
  appliedRevision: null,
})

/** Normalize the various list response envelopes ({ details }, { plugins },
 *  { schemas }, or a bare array) to a plain array. */
export const normalizeArray = (data: any): any[] =>
  Array.isArray(data) ? data : (data?.details ?? data?.plugins ?? data?.schemas ?? [])

/**
 * Single converging rule (PR-8):
 * - If a write is pending, wait until appliedRevision matches that accepted revision.
 * - Otherwise, mid-converge when observed desired revision lags applied (soft-fail / lag).
 */
export const isConfigConverging = (
  s: Pick<ConfigUIState, 'pendingRevision' | 'observedRevision' | 'appliedRevision'>,
): boolean => {
  if (s.pendingRevision != null) {
    return s.pendingRevision !== s.appliedRevision
  }
  const observed = s.observedRevision
  const applied = s.appliedRevision
  if (observed == null || applied == null || observed === '' || applied === '') {
    return false
  }
  return observed !== applied
}

/** Observed system snapshot (tree root) served by GET /config/systems. */
export type SystemSummary = {
  systemId: string
  plugins: PluginSummary[]
  revision: string
  appliedRevision: string
}

export type ConfigSyncStatus = 'synced' | 'applying' | 'degraded'

/**
 * Aggregate desired↔observed convergence status (PR-8 view over the
 * observed snapshot). `synced` when no write is pending and the desired
 * revision equals the applied revision; `degraded` when a stuck/failed
 * plugin is blocking convergence; otherwise `applying`.
 */
export const configSyncStatus = (
  s: Pick<ConfigUIState, 'pendingRevision' | 'observedRevision' | 'appliedRevision'>,
  plugins: PluginSummary[],
): { status: ConfigSyncStatus; label: string } => {
  if (!isConfigConverging(s)) return { status: 'synced', label: 'Synchronized' }
  const degraded = plugins.some(
    (p) =>
      p.status === 'failed' ||
      p.health?.status === 'unavailable' ||
      p.health?.status === 'degraded',
  )
  return degraded
    ? { status: 'degraded', label: 'Degraded' }
    : { status: 'applying', label: 'Applying…' }
}

/** Per-plugin convergence state from the observed snapshot. */
export const pluginSyncStatus = (p: PluginSummary): ConfigSyncStatus => {
  if (p.status === 'active' && p.health?.status === 'ok') return 'synced'
  if (p.status === 'failed' || p.health?.status === 'unavailable' || p.health?.status === 'degraded') {
    return 'degraded'
  }
  return 'applying'
}

const markAccepted = (revision: string | undefined | null) => {
  if (!revision) return
  const ns = store.namespace<ConfigUIState>('config')
  ns.set('pendingRevision', revision)
}

const markApplied = (revision?: string | null, appliedRevision?: string | null) => {
  const ns = store.namespace<ConfigUIState>('config')
  if (revision != null && revision !== '') ns.set('observedRevision', revision)
  if (appliedRevision != null && appliedRevision !== '') ns.set('appliedRevision', appliedRevision)
  const pending = ns.get('pendingRevision')
  const applied = ns.get('appliedRevision')
  if (pending && applied && pending === applied) {
    ns.set('pendingRevision', null)
  }
}

export const refreshConfigSystems = async () => {
  const ns = store.namespace<ConfigUIState>('config')
  try {
    const res = await fetch('/config/systems')
    if (!res.ok) return
    const systems = normalizeArray(await res.json()) as SystemSummary[]
    ns.set('systems', systems)
    const active = ns.get('activeSystemId')
    if (!systems.some(s => s.systemId === active)) {
      ns.set('activeSystemId', systems[0]?.systemId ?? 'local')
    }
  } catch { /* best-effort */ }
}

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
      // Desired raw — `${VAR}` placeholders, never live secrets.
      const data = await res.json()
      ns.set('currentValues', { ...ns.get('currentValues'), [pid]: data })
      ns.set('initialValues', { ...ns.get('initialValues'), [pid]: structuredClone(data) })
    } catch { /* per-plugin fetch is best-effort */ }
  }
}

/** Refetch one plugin's desired values after a remote change. Pending local
 *  edits on that plugin are discarded (last writer wins). */
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

/** Refetch desired values for every schema plugin that has no local dirty fields. */
export const refreshAllCleanValues = async (): Promise<void> => {
  const ns = store.namespace<ConfigUIState>('config')
  const schemas = ns.get('schemas') ?? []
  const dirty = ns.get('dirtyFields') ?? {}
  const pluginIds = [...new Set(schemas.map(s => s.id.split('.')[0]))].filter((id): id is string => Boolean(id))
  await Promise.all(
    pluginIds
      .filter((pid) => !dirty[pid] || Object.keys(dirty[pid]!).length === 0)
      .map((pid) => refreshConfigValues(pid)),
  )
}

/**
 * Apply an accepted mutation response: track pending revision until observed catches up.
 * Call after successful PATCH/POST with `{ accepted, revision }`.
 */
export const noteAcceptedRevision = (body: { accepted?: boolean; revision?: string } | null | undefined) => {
  if (body?.accepted && body.revision) markAccepted(body.revision)
}

export const reduceFrame = (frame: any) => {
  switch (frame?.type) {
    case 'config.schema':
      // Schema sections added/removed — refetch schemas and pull values for
      // any newly appeared plugin sections.
      refreshConfigSchemas().then(syncMissingValues)
      break
    case 'config.updated': {
      // Frames derived from observed diffs (config plugin adapter; PR-8).
      // WS flattens payload → frame.revision / frame.appliedRevision.
      markApplied(frame.revision, frame.appliedRevision ?? frame.revision)
      // Keep the per-system tree in sync with observed.
      void refreshConfigSystems()
      if (frame.pluginId) {
        void refreshConfigValues(frame.pluginId)
      } else {
        void refreshAllCleanValues()
      }
      break
    }
    case 'plugins.updated':
      void refreshConfigSystems()
      refreshConfigPlugins()
      refreshConfigSchemas().then(syncMissingValues)
      break
    case 'plugin.health.changed':
      void refreshConfigSystems()
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
