import type { PluginDef } from '../actor/types.ts'
import type { ActorHealth } from '../../types/health.ts'

// ─── Desired plane ───────────────────────────────────────────────────────────
//
// ConfigSource is the port for the desired-state store (file / static / NATS).
// Phase 2: read + write + watch (hint; resync is the guarantee).

export type PluginEntry = {
  def?: PluginDef<any, any, any>
  modulePath?: string
  reloadNonce?: number
}

export type DesiredState = {
  plugins: PluginEntry[]
  /** RAW config — `${VAR}` placeholders intact; interpolated at apply (D4). */
  config: Record<string, unknown>
}

/** Patch shape returned from ConfigSource.write updaters (before normalization). */
export type DesiredStatePatch = {
  plugins?: (PluginEntry | PluginDef<any, any, any>)[]
  config?: Record<string, unknown>
}

export type ConfigSource = {
  read(): Promise<{ state: DesiredState; revision: string }>
  write(
    patch: (curr: DesiredState) => DesiredStatePatch | Promise<DesiredStatePatch>,
  ): Promise<{ revision: string }>
  /** Hint that desired may have changed. Unsubscribe by calling the returned function. */
  watch(onChange: () => void): () => void
}

// ─── Observed plane (node-control sole writer; retained under systemId) ──────

/** Observed plugin summary — same shape the admin UI consumes. */
export type ObservedPlugin = {
  id: string
  version: string
  status: 'loading' | 'active' | 'failed' | 'deactivating'
  modulePath?: string
  error?: string
  health?: ActorHealth
}

/**
 * Reporting plane only: revisions + plugin summaries.
 * Intentionally omits live config values so interpolated secrets never leave the machine.
 */
export type ObservedState = {
  /** Identity of the node/system this snapshot describes. */
  systemId: string
  /** Desired hash last seen by node-control. */
  revision: string
  /** Desired hash fully converged (equals revision after a successful pass). */
  appliedRevision: string
  plugins: ObservedPlugin[]
  updatedAt: number
}
