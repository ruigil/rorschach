import { createTopic } from '../system/types.ts'
import type { ActorDef, EventTopic } from '../system/types.ts'

// ─── Public types ───

export type TaskEvent<R> =
  | { type: 'task.progress'; id: string; pct: number; note?: string }
  | { type: 'task.done';     id: string; result: R }
  | { type: 'task.failed';   id: string; error: string }

/** Returns the per-task event topic. Subscribe before sending the request. */
export const taskTopic = <R>(id: string): EventTopic<TaskEvent<R>> =>
  createTopic<TaskEvent<R>>(`worker/task/${id}`)

export type WorkerBridgeOptions = {
  /** Path to the worker script. Bun resolves this relative to the caller. */
  scriptPath: string
}

/** A worker bridge ready to spawn: the def and its matching initial state. */
export type WorkerBridge<P, R> = {
  def: ActorDef<WorkerBridgeMsg<P, R>, WorkerBridgeState>
  initialState: WorkerBridgeState
}

// ─── Internal types ───

/**
 * The bridge actor's message union.
 *
 * Callers send `{ type: 'request', id, payload }`.
 * The worker posts back `progress`/`reply`/`error` — routed to self via onmessage.
 *
 * NOTE: on supervision restart, in-flight tasks are lost — their topics will
 * never receive a terminal event. Callers should guard with a timer if needed.
 */
export type WorkerBridgeMsg<P, R> =
  | { type: 'request';  id: string; payload: P }
  | { type: 'progress'; id: string; pct: number; note?: string }
  | { type: 'reply';    id: string; result: R }
  | { type: 'error';    id: string; error: string }

export type WorkerBridgeState = {
  worker: Worker
}

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
    handler: (state, msg, ctx) => {
      switch (msg.type) {
        case 'request':
          state.worker.postMessage({ id: msg.id, payload: msg.payload })
          return { state }

        case 'progress':
          ctx.publish(taskTopic<R>(msg.id), {
            type: 'task.progress',
            id: msg.id,
            pct: msg.pct,
            ...(msg.note !== undefined ? { note: msg.note } : {}),
          })
          return { state }

        case 'reply':
          ctx.publish(taskTopic<R>(msg.id), { type: 'task.done', id: msg.id, result: msg.result })
          ctx.deleteTopic(taskTopic(msg.id))
          return { state }

        case 'error':
          ctx.publish(taskTopic<R>(msg.id), { type: 'task.failed', id: msg.id, error: msg.error })
          ctx.deleteTopic(taskTopic(msg.id))
          return { state }
      }
    },

    lifecycle: (state, event, ctx) => {
      if (event.type === 'start') {
        const worker = new Worker(options.scriptPath)
        worker.onmessage = (e: MessageEvent) => {
          ctx.self.send(e.data as WorkerBridgeMsg<P, R>)
        }
        worker.onerror = (err) => {
          ctx.log.error('worker thread error', { error: String(err) })
        }
        return { state: { worker } }
      }

      if (event.type === 'stopped') state.worker.terminate()
      return { state }
    },

    shutdown: { drain: true },
    supervision: { type: 'restart' },
  }

  return {
    def,
    initialState: { worker: null as unknown as Worker },
  }
}
