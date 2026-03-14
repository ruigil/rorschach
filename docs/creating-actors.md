# Creating an Actor

An actor is a self-contained unit that processes messages one at a time, maintains private state, and communicates with the outside world exclusively through messages.

## The Three Parts

To create an actor you define three things:

1. **Message type** — a union of all messages the actor can receive.
2. **State type** — the shape of the actor's private state.
3. **Actor definition** (`ActorDef<M, S>`) — the behavior: how to initialize, handle messages, and react to lifecycle events.

## Minimal Example

```ts
import type { ActorDef, ActorContext, ActorResult } from '../system/index.ts'

// 1. Messages
type CounterMsg =
  | { type: 'increment' }
  | { type: 'decrement' }

// 2. State
type CounterState = { count: number }

// 3. Definition
const counterDef: ActorDef<CounterMsg, CounterState> = {
  handler: (state, message, context): ActorResult<CounterState> => {
    switch (message.type) {
      case 'increment':
        context.log.info(`count is now ${state.count + 1}`)
        return { state: { count: state.count + 1 } }
      case 'decrement':
        return { state: { count: state.count - 1 } }
    }
  },
}

```

## Actor Definition Reference

All fields on `ActorDef<M, S>`:

| Field | Required | Description |
|---|---|---|
| `handler(state, message, context)` | **yes** | Called for every incoming message. Returns `{ state }` (and optionally `events`). |
| `setup(state, context)` | no | Runs once on start (and on restart). Returns the initial state, possibly enriched. |
| `lifecycle(state, event, context)` | no | Reacts to lifecycle events (`stopped`, `terminated`). Returns `{ state }`. |
| `supervision` | no | What to do when `handler` throws. Default: `{ type: 'stop' }`. |

### Handler return value (`ActorResult<S>`)

```ts
{
  state: S                // required — the next state
  events?: unknown[]      // optional — domain events auto-published to the event stream
}
```

Returning `events` publishes each entry to the event stream under a topic equal to the actor's name, so other actors or external subscribers can react to them.

## Context Services

The `context` object passed to `setup`, `handler`, and `lifecycle` provides the following services:

### `context.self`
A reference to this actor (`ActorRef<M>`). Useful to pass as a `replyTo` address in messages.

### `context.log`
Structured logger. Messages are emitted to the system log topic.
```ts
context.log.info('something happened', { detail: 42 })
// levels: debug | info | warn | error
```

### `context.timers`
Schedule messages to self.
```ts
// Fire once after delay
context.timers.startSingleTimer('my-timer', { type: 'tick' }, 5000)

// Fire repeatedly
context.timers.startPeriodicTimer('heartbeat', { type: 'ping' }, 1000)

// Cancel
context.timers.cancel('my-timer')

// Check
context.timers.isActive('heartbeat') // boolean
```
Timers are automatically cancelled when the actor stops or restarts.

### `context.spawn` / `context.stop`
Create and stop child actors. Children are automatically watched — their termination is delivered as a lifecycle event.
```ts
const childRef = context.spawn('worker', workerDef, workerInitialState)
context.stop(childRef) // request graceful stop
```

### `context.watch` / `context.unwatch`
Watch any actor (not just children) for termination. When the watched actor stops, a `terminated` lifecycle event is delivered.
```ts
context.watch(someRef)
```

### `context.lookup`
Find an actor by its full hierarchical name.
```ts
const ref = context.lookup<SomeMsg>('system/other-actor')
ref?.send({ type: 'hello' })
```

### `context.pipeToSelf`
Run async side-effects (fetch, DB queries, file I/O) without blocking the actor's message loop. The promise runs in the background; when it settles, the adapted result is enqueued into the actor's mailbox and processed sequentially like any other message.

```ts
// Kick off non-blocking async work
context.pipeToSelf(
  fetch('/api/data').then(r => r.json()),
  (data) => ({ type: 'dataLoaded', data }),       // onSuccess → M
  (err)  => ({ type: 'dataFailed', error: err }), // onFailure → M
)
// Return immediately — the actor keeps processing other messages
return { state: { ...state, loading: true } }
```

**Design notes:**
- Uses `enqueueSystem` internally — piped results bypass backpressure, matching the semantics of timer-scheduled messages. The actor explicitly requested this work; dropping the result would silently leave it in an inconsistent state.
- If the actor has stopped by the time the promise resolves, the result is silently discarded.
- Cancellation is the caller's responsibility (e.g., use `AbortController` inside the promise).
- If the `onSuccess`/`onFailure` adapter produces a message that causes handler to throw, it flows through the normal supervision policy.

### `context.publish` / `context.subscribe` / `context.unsubscribe`
Pub-sub on the system event stream. `subscribe` takes an adapter function that maps the raw event into the actor's message type, so events are processed through the normal message handler.
```ts
// Publishing
context.publish('my-topic', { some: 'data' })

// Subscribing (from inside an actor)
context.subscribe('my-topic', (event) => {
  const data = event as { some: string }
  return { type: 'externalData', payload: data } // must return M
})

context.unsubscribe('my-topic')
```

## Lifecycle Events

If you provide a `lifecycle` handler, it receives:

| Event | When |
|---|---|
| `{ type: 'stopped' }` | This actor is shutting down (after children have stopped). |
| `{ type: 'terminated', ref, reason, error? }` | A watched or child actor has terminated. `reason` is `'stopped'` or `'failed'`. |

```ts
lifecycle: (state, event, context) => {
  if (event.type === 'terminated') {
    context.log.warn(`${event.ref.name} died: ${event.reason}`)
  }
  return { state }
}
```

## Supervision

Control what happens when `handler` throws:

```ts
const def: ActorDef<Msg, State> = {
  handler: (state, msg, ctx) => { /* ... */ },

  // Stop on failure (default)
  supervision: { type: 'stop' },

  // Or restart: reset state, re-run setup, keep processing
  supervision: { type: 'restart' },

  // Bounded restart: max 3 failures within 10 seconds, then stop
  supervision: { type: 'restart', maxRetries: 3, withinMs: 10_000 },
}
```

## Ask Pattern

For request-response interactions from *outside* an actor (or when you need a `Promise`):

```ts
import { ask } from '../system/index.ts'

type Msg =
  | { type: 'getCount'; replyTo: ActorRef<number> }

// Inside the target actor's handler:
// case 'getCount': message.replyTo.send(state.count); return { state }

const count = await ask<Msg, number>(
  counterRef,
  (replyTo) => ({ type: 'getCount', replyTo }),
  { timeoutMs: 1000 }, // optional
)
```

## Setup Pattern (Resource Acquisition)

Use `setup` to acquire resources and `lifecycle` to release them on stop:

```ts
const def: ActorDef<Msg, State> = {
  setup: (state, context) => {
    const resource = acquireSomething()
    context.log.info('resource acquired')
    return { ...state, resource }
  },

  handler: (state, msg, ctx) => {
    // use state.resource
    return { state }
  },

  lifecycle: (state, event, context) => {
    if (event.type === 'stopped' && state.resource) {
      releaseSomething(state.resource)
      context.log.info('resource released')
    }
    return { state }
  },
}
```
