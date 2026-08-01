import type { Op } from '../actor/types.ts'
import type { DesiredState, PluginEntry } from './types.ts'

// ─── Pure converge (D8) ──────────────────────────────────────────────────────
//
// (desired, actual) → Op[]. No actors, no fs, no side effects.
// Order: Unloads → ApplyConfig? → Loads (desired file order).
// Identity changes (path / reloadNonce) expand to Unload + Load inside this
// assembly so the Op set stays 1:1 with SystemControl (D11: Op ≡ control surface).
// Config is applied before loads so plugins see desired slices (incl. configPath) at start.

export type PluginIdentity = {
  resolvedPath?: string
  id?: string
  reloadNonce?: number
}

export const identityOf = (
  entry: PluginEntry,
): PluginIdentity =>
  entry.def
    ? { resolvedPath: entry.modulePath, id: entry.def.id }
    : entry.modulePath
    ? { resolvedPath: entry.modulePath, reloadNonce: entry.reloadNonce }
    : {}

/** Identity of a desired plugin entry after path resolution. */
export type DesiredPluginIdentity = {
  entry: PluginEntry
  /** Absolute module path when known (resolved specifier or materialised modulePath). */
  resolvedPath?: string
  /** Plugin id when known without loading (materialised def only). */
  id?: string
  reloadNonce?: number
}

export type ConvergePluginActual = {
  id: string
  version?: string
  status: 'loading' | 'active' | 'failed' | 'deactivating'
  modulePath?: string
  reloadNonce?: number
}

export type ConvergeActual = {
  plugins: ConvergePluginActual[]
}

export type ConvergeOptions = {
  /**
   * When true, emit a single ApplyConfig with the full desired config tree.
   * Control sets this from config-subtree hash (configRevisionOf), not full document
   * revision — plugin-only desired edits leave this false.
   */
  configChanged: boolean
}

/** Normalize desired plugins into identities for matching. */
const identitiesOf = (
  desired: DesiredState,
): DesiredPluginIdentity[] =>
  desired.plugins.map((entry) => {
    const ident = identityOf(entry)
    return { entry, ...ident }
  })

/**
 * Pure diff: desired × actual → ops.
 *
 * Matching rules:
 * - Desired entry matches actual when resolved paths equal, or materialised id equals.
 * - Failed actual that still matches desired → Load (loadPlugin failed-repair only).
 * - Specifier path or reloadNonce change → Unload + Load (converge owns identity unload sequencing;
 *   loadPlugin is an idempotent effector and hard-errors if called with a conflicting active path).
 *
 * Op set ≡ SystemControl: Unload | Load | ApplyConfig only (D11).
 */
export const converge = (
  desired: DesiredState,
  actual: ConvergeActual,
  options: ConvergeOptions,
): Op[] => {
  const identities = identitiesOf(desired)

  const unloads: Op[] = []
  const loads: Op[] = []

  // Map actual id → which desired identity it satisfies (if any)
  const matchedActualIds = new Set<string>()

  const pathOfActual = (p: ConvergePluginActual): string | undefined =>
    p.modulePath

  /** Identity change: unload joins unload phase; re-load joins loads in desired order. */
  const unloadThenLoad = (id: string, entry: PluginEntry): void => {
    unloads.push({ type: 'Unload', id })
    loads.push({ type: 'Load', entry })
  }

  for (const ident of identities) {
    let match: ConvergePluginActual | undefined

    if (ident.id) {
      match = actual.plugins.find((p) => p.id === ident.id)
    }
    if (!match && ident.resolvedPath) {
      match = actual.plugins.find((p) => pathOfActual(p) === ident.resolvedPath)
    }

    if (!match) {
      loads.push({ type: 'Load', entry: ident.entry })
      continue
    }

    matchedActualIds.add(match.id)

    if (match.status === 'failed') {
      loads.push({ type: 'Load', entry: ident.entry })
      continue
    }

    // Path change for same id (e.g. materialised id match but different path)
    const actualPath = pathOfActual(match)
    if (
      ident.resolvedPath &&
      actualPath &&
      ident.resolvedPath !== actualPath
    ) {
      unloadThenLoad(match.id, ident.entry)
      continue
    }

    // reloadNonce change (phase 2)
    const appliedNonce = match.reloadNonce
    const desiredNonce = ident.reloadNonce
    if (
      desiredNonce !== undefined &&
      appliedNonce !== desiredNonce
    ) {
      unloadThenLoad(match.id, ident.entry)
      continue
    }
  }

  for (const p of actual.plugins) {
    if (matchedActualIds.has(p.id)) continue
    unloads.push({ type: 'Unload', id: p.id })
  }

  const ops: Op[] = [...unloads]

  if (options.configChanged) {
    ops.push({ type: 'ApplyConfig', tree: desired.config })
  }

  ops.push(...loads)
  return ops
}
