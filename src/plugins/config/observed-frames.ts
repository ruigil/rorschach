import type { ObservedState } from '../../system/node/types.ts'

/**
 * Admin WS frame shapes for post-converge notify (client contract).
 * Derived solely from observed-plane diffs — never from node-control directly.
 */
export type ConfigAdminFrame = {
  type: 'plugins.updated' | 'config.updated'
  key: string
  payload: Record<string, unknown>
}

/**
 * Diff previous vs next observed snapshot → admin WS frames.
 *
 * Sole home for `plugins.updated` / `config.updated` derivation (PR-8).
 * Node-control writes only `system.config.observed`; this adapter is the view.
 *
 * Rules:
 * - plugin id appear → plugins.updated { action: 'add' }
 * - plugin id disappear → plugins.updated { action: 'remove' }
 * - revision or appliedRevision change (incl. first retain) → config.updated
 */
export const framesFromObservedDiff = (
  prev: ObservedState | null,
  next: ObservedState,
): ConfigAdminFrame[] => {
  const frames: ConfigAdminFrame[] = []
  const prevPlugins = prev?.plugins ?? []
  const prevIds = new Set(prevPlugins.map((p) => p.id))
  const nextIds = new Set(next.plugins.map((p) => p.id))

  for (const p of next.plugins) {
    if (!prevIds.has(p.id)) {
      frames.push({
        type: 'plugins.updated',
        key: 'system',
        payload: { action: 'add', id: p.id },
      })
    }
  }
  for (const p of prevPlugins) {
    if (!nextIds.has(p.id)) {
      frames.push({
        type: 'plugins.updated',
        key: 'system',
        payload: { action: 'remove', id: p.id },
      })
    }
  }

  if (
    !prev ||
    prev.revision !== next.revision ||
    prev.appliedRevision !== next.appliedRevision
  ) {
    frames.push({
      type: 'config.updated',
      key: 'system',
      payload: {
        revision: next.revision,
        appliedRevision: next.appliedRevision,
      },
    })
  }

  return frames
}
