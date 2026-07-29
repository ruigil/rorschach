/** Self-assessed capability while alive. */
export type HealthStatus = 'ok' | 'degraded' | 'unavailable'

/**
 * What an actor reports about itself; also the snapshot/plugin-record shape.
 * `detail` is the only explanation channel — human-readable, UI-safe.
 */
export type ActorHealth = {
  status: HealthStatus
  /** Human-readable explanation (UI-safe; no secrets). */
  detail?: string
}

/** Full watched-actor status: alive statuses + terminal (runtime-only). */
export type WatchStatus = HealthStatus | 'terminated'
