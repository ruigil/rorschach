import type {
  ActorContext,
  ActorResult,
  LifecycleEvent,
  LifecycleResult,
  MessageHandler,
} from './types.ts'

// ─── onLifecycle ─────────────────────────────────────────────────────────────
//
// Replaces if-chains on event.type with a typed cases object.
// Each case receives the minimal signature for that event — terminated
// receives the full event (ref, reason, error); all others receive (state, ctx).
// Omitted cases default to `{ state }` (no change).
//
// Usage:
//   lifecycle: onLifecycle({
//     start(state, ctx)      { ... return { state } },
//     stopped(state, ctx)    { ... return { state } },
//     terminated(state, e, ctx) { ... return { state } },
//   })
//

type TerminatedEvent = Extract<LifecycleEvent, { type: 'terminated' }>

type LifecycleCases<M, S> = {
  start?:      (state: S, ctx: ActorContext<M>) => LifecycleResult<S> | Promise<LifecycleResult<S>>
  stopping?:   (state: S, ctx: ActorContext<M>) => LifecycleResult<S> | Promise<LifecycleResult<S>>
  stopped?:    (state: S, ctx: ActorContext<M>) => LifecycleResult<S> | Promise<LifecycleResult<S>>
  terminated?: (state: S, event: TerminatedEvent, ctx: ActorContext<M>) => LifecycleResult<S> | Promise<LifecycleResult<S>>
}

export const onLifecycle = <M, S>(
  cases: LifecycleCases<M, S>,
): (state: S, event: LifecycleEvent, ctx: ActorContext<M>) => LifecycleResult<S> | Promise<LifecycleResult<S>> =>
  (state, event, ctx) => {
    switch (event.type) {
      case 'start':      return cases.start?.(state, ctx)             ?? { state }
      case 'stopping':   return cases.stopping?.(state, ctx)          ?? { state }
      case 'stopped':    return cases.stopped?.(state, ctx)           ?? { state }
      case 'terminated': return cases.terminated?.(state, event, ctx) ?? { state }
    }
  }

// ─── onMessage ───────────────────────────────────────────────────────────────
//
// Replaces switch(msg.type) / if(msg.type === ...) with a typed cases object.
// Requires M to be a discriminated union on a `type` field.
// Each case receives a narrowed `msg` — no casting needed inside the case body.
// An optional `fallback` handles message variants not listed in cases.
// Omitted cases with no fallback default to `{ state }` (no change).
//
// Usage:
//   handler: onMessage({
//     add(state, msg, ctx)    { ... return { state } },  // msg narrowed to Extract<M, { type: 'add' }>
//     remove(state, msg, ctx) { ... return { state } },
//   })
//

type MessageCases<M extends { type: string }, S> = {
  [K in M['type']]?: (
    state: S,
    msg: Extract<M, { type: K }>,
    ctx: ActorContext<M>,
  ) => ActorResult<M, S>
}

export const onMessage = <M extends { type: string }, S>(
  cases: MessageCases<M, S>,
  fallback?: (state: S, msg: M, ctx: ActorContext<M>) => ActorResult<M, S>,
): MessageHandler<M, S> =>
  (state, msg, ctx) => {
    const fn = cases[msg.type as M['type']] as
      | ((state: S, msg: M, ctx: ActorContext<M>) => ActorResult<M, S>)
      | undefined
    if (fn) return fn(state, msg, ctx)
    if (fallback) return fallback(state, msg, ctx)
    return { state }
  }
