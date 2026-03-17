import { DeadLetterTopic } from '../../system/types.ts'
import type { ActorDef, ActorRef } from '../../system/types.ts'

// ─── Public types ───

export type PoolRouterOnFailure = 'replace' | 'shrink' | 'escalate'

export type PoolRouterOptions<WM, WS> = {
  /** Number of worker actors to spawn in the pool. */
  poolSize: number
  /** The actor definition used for each worker. */
  worker: ActorDef<WM, WS>
  /** Initial state passed to each worker on spawn (and on replace). */
  workerInitialState: WS
  /**
   * What to do when a worker terminates unexpectedly:
   * - 'replace'  — spawn a new worker, maintaining pool size (default)
   * - 'shrink'   — remove the dead worker, reducing pool size permanently;
   *                messages sent when the pool is empty go to dead letters
   * - 'escalate' — stop the router by throwing in the lifecycle handler,
   *                triggering the router's own supervision strategy
   */
  onWorkerFailure?: PoolRouterOnFailure
}

/** Internal state of the pool router actor. */
export type PoolRouterState<WM> = {
  workers: ActorRef<WM>[]
  index: number
  workerSeq: number
}

/** A pool router ready to spawn: the def and its matching initial state. */
export type PoolRouter<WM> = {
  def: ActorDef<WM, PoolRouterState<WM>>
  initialState: PoolRouterState<WM>
}

/**
 * Creates a pool router.
 *
 * Returns `{ def, initialState }` — pass both to `system.spawn` or `context.spawn`:
 *
 *   const router = createPoolRouter({ poolSize: 4, worker: workerDef, workerInitialState: {} })
 *   system.spawn('workers', router.def, router.initialState)
 *
 * The router distributes incoming messages across the pool using round-robin.
 * Each worker is a full child actor of the router, participating in the
 * supervision hierarchy with its own mailbox, metrics, and lifecycle.
 *
 * Worker failure behaviour is controlled by `onWorkerFailure` (default: 'replace').
 */
export const createPoolRouter = <WM, WS>(
  options: PoolRouterOptions<WM, WS>,
): PoolRouter<WM> => {
  const { poolSize, worker, workerInitialState, onWorkerFailure = 'replace' } = options

  if (poolSize < 1) {
    throw new RangeError(`Pool router poolSize must be >= 1, got ${poolSize}`)
  }

  const def: ActorDef<WM, PoolRouterState<WM>> = {
    handler: (state, message, ctx) => {
      if (state.workers.length === 0) {
        ctx.publish(DeadLetterTopic, {
          recipient: ctx.self.name,
          message,
          timestamp: Date.now(),
        })
        return { state }
      }

      state.workers[state.index % state.workers.length]!.send(message)
      return { state: { ...state, index: state.index + 1 } }
    },

    lifecycle: (state, event, ctx) => {
      if (event.type === 'start') {
        const workers: ActorRef<WM>[] = []
        for (let i = 0; i < poolSize; i++) {
          workers.push(ctx.spawn(`worker-${i}`, worker, workerInitialState))
        }
        return { state: { workers, index: 0, workerSeq: poolSize } }
      }

      if (event.type !== 'terminated') return { state }
      // Only react to unexpected failures — graceful stops (shutdown, ctx.stop)
      // are expected and should not trigger the failure strategy.
      if (event.reason !== 'failed') return { state }

      const deadName = event.ref.name
      if (!state.workers.some(w => w.name === deadName)) return { state }

      if (onWorkerFailure === 'escalate') {
        const detail = event.error != null ? String(event.error) : event.reason
        throw new Error(`Pool router worker "${deadName}" terminated: ${detail}`)
      }

      const workers = state.workers.filter(w => w.name !== deadName)

      if (onWorkerFailure === 'replace') {
        const newWorker = ctx.spawn(`worker-${state.workerSeq}`, worker, workerInitialState)
        return {
          state: {
            workers: [...workers, newWorker],
            index: state.index,
            workerSeq: state.workerSeq + 1,
          },
        }
      }

      // shrink
      if (workers.length === 0) {
        ctx.log.warn('pool router pool is empty — messages will go to dead letters')
      }
      return {
        state: {
          workers,
          index: workers.length > 0 ? state.index % workers.length : 0,
          workerSeq: state.workerSeq,
        },
      }
    },
  }

  return {
    def,
    initialState: { workers: [], index: 0, workerSeq: 0 },
  }
}
