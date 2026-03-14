import type { ActorMetrics, ActorSnapshot, ActorStatus, ActorTreeNode, MetricsRegistry, ProcessingTime } from './types.ts'

/**
 * Creates an ActorMetrics instance scoped to a single actor.
 *
 * Tracks counters (messagesProcessed, messagesReceived, messagesFailed, restartCount),
 * processing time summary (min/max/avg/sum/count), and status. Gauge values
 * (mailboxSize, stashSize, childCount, children) are read from live getter
 * callbacks on each snapshot — no stale copies.
 *
 * Hot-path cost: counter increments and Math.min/Math.max per message. Zero allocations.
 */
export const createActorMetrics = (
  name: string,
  gauges: {
    readonly mailboxSize: () => number
    readonly stashSize: () => number
    readonly childCount: () => number
    readonly children: () => string[]
  },
): ActorMetrics => {
  let status: ActorStatus = 'running'
  const startedAt = Date.now()

  // ─── Counters ───
  let messagesReceived = 0
  let messagesProcessed = 0
  let messagesFailed = 0
  let restartCount = 0
  let lastMessageTimestamp: number | null = null

  // ─── Processing time summary ───
  let ptCount = 0
  let ptSum = 0
  let ptMin = Infinity
  let ptMax = -Infinity

  const recordMessageReceived = (): void => {
    messagesReceived++
  }

  const recordMessageProcessed = (durationMs: number): void => {
    messagesProcessed++
    lastMessageTimestamp = Date.now()
    ptCount++
    ptSum += durationMs
    if (durationMs < ptMin) ptMin = durationMs
    if (durationMs > ptMax) ptMax = durationMs
  }

  const recordMessageFailed = (): void => {
    messagesFailed++
  }

  const recordRestart = (): void => {
    restartCount++
  }

  const setStatus = (s: ActorStatus): void => {
    status = s
  }

  const snapshot = (): ActorSnapshot => {
    const processingTime: ProcessingTime = ptCount > 0
      ? { count: ptCount, sum: ptSum, min: ptMin, max: ptMax, avg: ptSum / ptCount }
      : { count: 0, sum: 0, min: 0, max: 0, avg: 0 }

    return {
      name,
      status,
      uptime: Date.now() - startedAt,
      messagesReceived,
      messagesProcessed,
      messagesFailed,
      restartCount,
      mailboxSize: gauges.mailboxSize(),
      stashSize: gauges.stashSize(),
      childCount: gauges.childCount(),
      lastMessageTimestamp,
      processingTime,
      children: gauges.children(),
    }
  }

  return {
    recordMessageReceived,
    recordMessageProcessed,
    recordMessageFailed,
    recordRestart,
    setStatus,
    snapshot,
  }
}

/**
 * Creates the system-level MetricsRegistry.
 *
 * Each actor registers its ActorMetrics object after setup and unregisters on stop.
 * External code queries snapshots on demand via snapshot/snapshotAll/actorTree.
 */
export const createMetricsRegistry = (): MetricsRegistry => {
  const actors = new Map<string, ActorMetrics>()

  const register = (name: string, metrics: ActorMetrics): void => {
    actors.set(name, metrics)
  }

  const unregister = (name: string): void => {
    actors.delete(name)
  }

  const snapshot = (name: string): ActorSnapshot | undefined => {
    return actors.get(name)?.snapshot()
  }

  const snapshotAll = (): ActorSnapshot[] => {
    const results: ActorSnapshot[] = []
    for (const metrics of actors.values()) {
      results.push(metrics.snapshot())
    }
    return results
  }

  const actorTree = (): ActorTreeNode[] => {
    // Build tree from flat snapshot list using name hierarchy (parent/child convention)
    const snapshots = snapshotAll()
    const nodeMap = new Map<string, ActorTreeNode>()

    // Create nodes for all actors
    for (const s of snapshots) {
      nodeMap.set(s.name, { name: s.name, status: s.status, children: [] })
    }

    // Build the tree by finding parent-child relationships
    const roots: ActorTreeNode[] = []

    for (const s of snapshots) {
      const lastSlash = s.name.lastIndexOf('/')
      if (lastSlash === -1) {
        // Top-level actor (no slash) — root node
        roots.push(nodeMap.get(s.name)!)
      } else {
        const parentName = s.name.substring(0, lastSlash)
        const parentNode = nodeMap.get(parentName)
        if (parentNode) {
          ;(parentNode.children as ActorTreeNode[]).push(nodeMap.get(s.name)!)
        } else {
          // Parent not in registry (might be stopped) — treat as root
          roots.push(nodeMap.get(s.name)!)
        }
      }
    }

    return roots
  }

  return { register, unregister, snapshot, snapshotAll, actorTree }
}
