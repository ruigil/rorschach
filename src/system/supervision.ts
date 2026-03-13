import type { SupervisionStrategy } from './types.ts'

/**
 * A supervision policy encapsulates the retry-window logic for an actor.
 *
 * On each failure, call `onFailure()` to determine whether to restart or stop.
 * The policy tracks failure timestamps internally for windowed retry limiting.
 */
export type SupervisionPolicy = {
  /** Returns 'restart' if the actor should restart, 'stop' if retries are exhausted or strategy is stop. */
  readonly onFailure: () => 'restart' | 'stop'
}

/**
 * Creates a supervision policy from a strategy definition.
 *
 * - `{ type: 'stop' }` — always returns 'stop'
 * - `{ type: 'restart' }` — returns 'restart', optionally bounded by maxRetries/withinMs
 */
export const createSupervisionPolicy = (strategy: SupervisionStrategy): SupervisionPolicy => {
  if (strategy.type === 'stop') {
    return { onFailure: () => 'stop' }
  }

  // Restart strategy — track failure timestamps for windowed retry limiting
  const failureTimestamps: number[] = []
  const { maxRetries, withinMs } = strategy

  const onFailure = (): 'restart' | 'stop' => {
    if (maxRetries === undefined) return 'restart' // unlimited retries

    const now = Date.now()

    if (withinMs !== undefined) {
      // Sliding window: only count failures within the time window
      const cutoff = now - withinMs
      while (failureTimestamps.length > 0 && failureTimestamps[0]! < cutoff) {
        failureTimestamps.shift()
      }
    }

    failureTimestamps.push(now)
    return failureTimestamps.length <= maxRetries ? 'restart' : 'stop'
  }

  return { onFailure }
}
