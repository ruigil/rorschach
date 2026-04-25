import type { ActorDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import type {
  TaskEvent, WorkerBridge, WorkerBridgeMsg, WorkerBridgeOptions, WorkerBridgeState,
} from './types.ts'
import { taskTopic } from './types.ts'

/**
 * Creates a worker thread bridge actor.
 *
 * Returns `{ def, initialState }` — pass both to `system.spawn` or `context.spawn`:
 *
 *   const bridge = createWorkerBridge<Payload, Result>({ scriptPath: './my-worker.ts' })
 *   const ref = system.spawn('bridge', bridge.def, bridge.initialState)
 *
 * The bridge spawns a single Worker thread and routes messages to/from it.
 * Progress and completion events are published to `taskTopic(id)` on the system
 * event stream, so any actor can observe a task by subscribing before sending the request:
 *
 *   ctx.subscribe(taskTopic<Result>(id), event => ({ type: 'task.event', event }))
 *   ref.send({ type: 'request', id, payload })
 *
 * The topic is deleted after the terminal event (`task.done` or `task.failed`),
 * so no cleanup is required by the caller.
 *
 * Worker script contract:
 *
 *   self.onmessage = async ({ data: { id, payload } }) => {
 *     try {
 *       self.postMessage({ type: 'progress', id, pct: 50 })         // optional
 *       self.postMessage({ type: 'reply', id, result: await work(payload) })
 *     } catch (err) {
 *       self.postMessage({ type: 'error', id, error: String(err) })
 *     }
 *   }
 */
export const createWorkerBridge = <P, R>(
  options: WorkerBridgeOptions,
): WorkerBridge<P, R> => {
  const def: ActorDef<WorkerBridgeMsg<P, R>, WorkerBridgeState> = {
    handler: onMessage({
      request: (state, msg) => {
        state.worker.postMessage({ id: msg.id, payload: msg.payload })
        return { state }
      },
      progress: (state, msg, ctx) => {
        ctx.publish(taskTopic<R>(msg.id), {
          type: 'task.progress',
          id: msg.id,
          pct: msg.pct,
          ...(msg.note !== undefined ? { note: msg.note } : {}),
        })
        return { state }
      },
      reply: (state, msg, ctx) => {
        ctx.publish(taskTopic<R>(msg.id), { type: 'task.done', id: msg.id, result: msg.result })
        ctx.deleteTopic(taskTopic(msg.id))
        return { state }
      },
      error: (state, msg, ctx) => {
        ctx.publish(taskTopic<R>(msg.id), { type: 'task.failed', id: msg.id, error: msg.error })
        ctx.deleteTopic(taskTopic(msg.id))
        return { state }
      },
    }),

    lifecycle: onLifecycle({
      start: (_state, ctx) => {
        const worker = new Worker(options.scriptPath)
        worker.onmessage = (e: MessageEvent) => {
          ctx.self.send(e.data as WorkerBridgeMsg<P, R>)
        }
        worker.onerror = (err) => {
          ctx.log.error('worker thread error', { error: String(err) })
        }
        return { state: { worker } }
      },
      stopped: (state) => {
        state.worker.terminate()
        return { state }
      },
    }),

    shutdown: { drain: true },
    supervision: { type: 'restart' },
  }

  return {
    def,
    initialState: { worker: null as unknown as Worker },
  }
}
