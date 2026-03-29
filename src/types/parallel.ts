import { createTopic } from '../system/types.ts'
import type { ActorDef, EventTopic } from '../system/types.ts'

// ─── Task event types ───

export type TaskEvent<R> =
  | { type: 'task.progress'; id: string; pct: number; note?: string }
  | { type: 'task.done';     id: string; result: R }
  | { type: 'task.failed';   id: string; error: string }

/** Returns the per-task event topic. Subscribe before sending the request. */
export const taskTopic = <R>(id: string): EventTopic<TaskEvent<R>> =>
  createTopic<TaskEvent<R>>(`worker/task/${id}`)

// ─── Worker bridge options ───

export type WorkerBridgeOptions = {
  /** Path to the worker script. Bun resolves this relative to the caller. */
  scriptPath: string
}

/** A worker bridge ready to spawn: the def and its matching initial state. */
export type WorkerBridge<P, R> = {
  def: ActorDef<WorkerBridgeMsg<P, R>, WorkerBridgeState>
  initialState: WorkerBridgeState
}

// ─── Worker bridge message protocol ───

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
