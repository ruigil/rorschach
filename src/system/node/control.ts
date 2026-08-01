import type { ActorContext, ActorDef, ActorResult, Op, SystemControl, ActualSnapshot } from '../actor/types.ts'
import { onLifecycle, onMessage } from '../actor/match.ts'
import { SystemObservedTopic } from '../../types/config.ts'
import type {
  ConfigSource,
  DesiredState,
  ObservedPlugin,
  ObservedState,
} from './types.ts'
import { converge} from './converge.ts'
import { configRevisionOf } from './config-sources.ts'

// ─── Node control actor ──────────────────────────────────────────────────────
//
// Kernel child at system/node-control. Sole holder of SystemControl.
// Converges actual → desired on: first boot, watch hint, jittered resync.
// Soft-fail always (Load failures, source.read failures); level-triggered recover.
// Admin surface never messages this actor — rendezvous is the store only.
//
// Applied-revision policy: a pass is successful (appliedRevision = revision) when
// Unload/ApplyConfig succeed. Soft-failed Loads still complete the pass with ok
// (failed plugins stay in observed with status 'failed'); hard failures leave
// appliedRevision lagging and schedule retry.
//
// Active plugin identity (path + reloadNonce) lives on ActualSnapshot.plugins[].
// Control does not keep a parallel Map.
//
// Post-converge external write: system.observed only (PR-8). Admin WS frames
// (plugins.updated / config.updated) are derived by the config plugin from
// observed diffs — control does not publish OutboundAdminBroadcast.

const RESYNC_BASE_MS = 30_000
const RESYNC_JITTER_MS = 5_000
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000

export type NodeControlDeps = {
  control: SystemControl
  source: ConfigSource
  /** Retained observed key (default 'local'). */
  systemId?: string
  /**
   * Called once after the first converge pass finishes (success or soft-fail).
   * AgentSystem awaits this so the constructor resolves after boot attempt.
   */
  onFirstConvergeDone?: () => void
}

type NodeControlState = {
  inFlight: boolean
  /** True when a converge was requested while one was already running. */
  pending: boolean
  /** Full desired document revision last successfully converged (observed lag). */
  lastAppliedRevision: string | null
  /**
   * Config-subtree hash last successfully applied via ApplyConfig.
   * Independent of document revision so plugin-only writes skip ApplyConfig.
   */
  lastAppliedConfigRevision: string | null
  backoffMs: number
  unwatch: (() => void) | null
  /** Still waiting to signal onFirstConvergeDone. */
  firstPassPending: boolean
}

type ConvergeDone = {
  type: '_convergeDone'
  ok: boolean
  revision: string
  /** Desired config hash for this pass; stamped on success. */
  configRevision?: string
}

type NodeControlMsg =
  | { type: '_converge'; reason: 'boot' | 'watch' | 'resync' | 'retry' }
  | ConvergeDone
  | { type: '_resyncTick' }

const toObservedPlugin = (p: ActualSnapshot['plugins'][number]): ObservedPlugin => ({
  ...p,
  error: p.error !== undefined ? String(p.error) : undefined,
})

/**
 * Execute ops 1:1 with SystemControl (D11: Op set ≡ control surface).
 * Load failures are soft (continue); Unload/ApplyConfig hard-fail the pass.
 * Identity reloads arrive already expanded as Unload then Load from converge.
 */
const executeOps = async (
  ops: Op[],
  control: SystemControl,
): Promise<{ ok: boolean; error?: string }> => {
  for (const op of ops) {
    if (op.type === 'Unload') {
      const result = await control.unloadPlugin(op.id)
      if (!result.ok) return { ok: false, error: result.error }
      continue
    }
    if (op.type === 'Load') {
      const result = await control.loadPlugin(op.entry)
      if (!result.ok) {
        console.warn(`[node-control] load failed (soft):`, result.error)
      }
      continue
    }
    if (op.type === 'ApplyConfig') {
      const result = await control.applyConfig(op.tree)
      if (!result.ok) return { ok: false, error: result.error }
    }
  }
  return { ok: true }
}

const publishObserved = (
  ctx: ActorContext<NodeControlMsg>,
  systemId: string,
  state: {
    revision: string
    appliedRevision: string
    plugins: ObservedPlugin[]
  },
): void => {
  const observed: ObservedState = {
    revision: state.revision,
    appliedRevision: state.appliedRevision,
    plugins: state.plugins,
    updatedAt: Date.now(),
  }
  ctx.publishRetained(SystemObservedTopic, systemId, observed)
}

/**
 * Create the node-control actor definition closed over SystemControl + source.
 */
export const createNodeControlDef = (
  deps: NodeControlDeps,
): ActorDef<NodeControlMsg, NodeControlState> => {
  const { control, source, onFirstConvergeDone } = deps
  const systemId = deps.systemId ?? 'local'

  const scheduleResync = (ctx: ActorContext<NodeControlMsg>, delayMs?: number) => {
    const jitter = delayMs !== undefined ? 0 : Math.floor(Math.random() * RESYNC_JITTER_MS)
    const delay = (delayMs ?? RESYNC_BASE_MS) + jitter
    ctx.timers.startSingleTimer('resync', { type: '_resyncTick' }, delay)
  }

  const signalFirstDone = (state: NodeControlState): NodeControlState => {
    if (!state.firstPassPending) return state
    onFirstConvergeDone?.()
    return { ...state, firstPassPending: false }
  }

  const requestConverge = (
    state: NodeControlState,
    ctx: ActorContext<NodeControlMsg>,
    reason: 'boot' | 'watch' | 'resync' | 'retry',
  ): ActorResult<NodeControlMsg, NodeControlState> => {
    if (state.inFlight) {
      return { state: { ...state, pending: true } }
    }

    const run = async (): Promise<Omit<ConvergeDone, 'type'>> => {
      let desired: DesiredState
      let revision: string
      try {
        const read = await source.read()
        desired = read.state
        revision = read.revision
      } catch (e) {
        console.warn(`[node-control] source.read failed:`, e)
        return { ok: false, revision: '' }
      }

      const snap = control.snapshotActual()

      // Config identity is independent of full document revision (PR-6).
      const configRevision = configRevisionOf(desired.config)
      const configChanged =
        state.lastAppliedConfigRevision === null ||
        state.lastAppliedConfigRevision !== configRevision

      const ops = converge(
        desired,
        snap,
        { configChanged },
      )

      if (ops.length === 0) {
        return { ok: true, revision, configRevision }
      }

      const result = await executeOps(ops, control)
      if (!result.ok) {
        console.warn(`[node-control] converge failed (${reason}):`, result.error)
        return { ok: false, revision, configRevision }
      }

      return { ok: true, revision, configRevision }
    }

    ctx.pipeToSelf(
      run(),
      (result) => ({ type: '_convergeDone' as const, ...result }),
      () => ({
        type: '_convergeDone' as const,
        ok: false,
        revision: '',
      }),
    )

    return { state: { ...state, inFlight: true } }
  }

  return {
    // Restart-safe: plugin identities live on ActualSnapshot (process-local registry).
    supervision: { type: 'restart', backoffMs: 100, maxBackoffMs: 5_000 },

    initialState: (): NodeControlState => ({
      inFlight: false,
      pending: false,
      lastAppliedRevision: null,
      lastAppliedConfigRevision: null,
      backoffMs: BACKOFF_MIN_MS,
      unwatch: null,
      firstPassPending: true,
    }),

    lifecycle: onLifecycle<NodeControlMsg, NodeControlState>({
      start: (state, ctx) => {
        const unwatch = source.watch(() => {
          ctx.self.send({ type: '_converge', reason: 'watch' })
        })
        scheduleResync(ctx)
        // First convergence is boot — AgentSystem awaits onFirstConvergeDone.
        return requestConverge({ ...state, unwatch }, ctx, 'boot')
      },
      stopping: (state, ctx) => {
        state.unwatch?.()
        ctx.timers.cancel('resync')
        ctx.timers.cancel('retry')
        // If stopped before first pass completes, still release the constructor.
        if (state.firstPassPending) onFirstConvergeDone?.()
        return { state: { ...state, unwatch: null, firstPassPending: false } }
      },
    }),

    handler: onMessage<NodeControlMsg, NodeControlState>({
      _converge: (state, { reason }, ctx) => requestConverge(state, ctx, reason),

      _resyncTick: (state, _msg, ctx) => {
        scheduleResync(ctx)
        return requestConverge(state, ctx, 'resync')
      },

      _convergeDone: (state, msg, ctx) => {
        const snap = control.snapshotActual()
        const plugins = snap.plugins.map(toObservedPlugin)
        const prevRevision = state.lastAppliedRevision

        let next: NodeControlState = {
          ...state,
          inFlight: false,
        }

        if (msg.ok) {
          next = {
            ...next,
            lastAppliedRevision: msg.revision,
            // Stamp config-subtree hash on successful pass (ApplyConfig or already current).
            lastAppliedConfigRevision:
              msg.configRevision ?? state.lastAppliedConfigRevision,
            backoffMs: BACKOFF_MIN_MS,
          }
          // Sole external write: observed. Frames derived by config plugin (PR-8).
          publishObserved(ctx, systemId, {
            revision: msg.revision,
            appliedRevision: msg.revision,
            plugins,
          })
        } else {
          // Soft-fail: publish observed with best-effort revision; applied on actual is already stamped.
          publishObserved(ctx, systemId, {
            revision: msg.revision || prevRevision || '',
            appliedRevision: prevRevision ?? '',
            plugins,
          })
          const backoff = Math.min(state.backoffMs * 2, BACKOFF_MAX_MS)
          next = { ...next, backoffMs: backoff }
          ctx.timers.startSingleTimer(
            'retry',
            { type: '_converge', reason: 'retry' },
            state.backoffMs,
          )
        }

        next = signalFirstDone(next)

        if (next.pending) {
          return requestConverge({ ...next, pending: false }, ctx, 'watch')
        }

        return { state: next }
      },
    }),
  }
}
