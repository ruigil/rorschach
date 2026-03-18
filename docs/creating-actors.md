# Creating an Actor

An actor is a self-contained unit that processes messages one at a time, maintains private state, and communicates with the outside world exclusively through messages.

In this system, actors live inside **plugins**. A `PluginDef<M, S>` is an `ActorDef<M, S>` with plugin metadata attached — it is both the actor and the deployment unit. See [Plugins](#plugins) for details.

## The Three Parts

To create an actor you define three things:

1. **Message type** — a union of all messages the actor can receive.
2. **State type** — the shape of the actor's private state.
3. **Actor definition** (`ActorDef<M, S>`) — the behavior: how to handle messages and react to lifecycle events.

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
  handler: (state, message, context): ActorResult<CounterMsg, CounterState> => {
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
| `handler(state, message, context)` | **yes** | Called for every incoming message. Returns an `ActorResult`. |
| `lifecycle(state, event, context)` | no | Reacts to lifecycle events (`start`, `stopping`, `stopped`, `terminated`). Returns `{ state }`. May be async. |
| `supervision` | no | What to do when `handler` throws. Default: `{ type: 'stop' }`. |
| `mailbox` | no | Backpressure configuration (capacity, overflow strategy). Default: unbounded. |
| `stashCapacity` | no | Max messages in the stash. Oldest is dropped to dead letters when exceeded. Default: `1000`. |
| `shutdown` | no | Graceful shutdown: drain mailbox before stopping. Default: immediate stop. |
| `interceptors` | no | Middleware pipeline wrapping the handler. |
| `persistence` | no | Persistence adapter for state snapshots across restarts. |

## Handler Return Value (`ActorResult<M, S>`)

The handler returns one of three variants:

### Normal — process and update state

```ts
return {
  state: newState,
  events?: TypedEvent[],  // optional domain events to publish
}
```

### Become — switch to a different handler

```ts
return {
  state: newState,
  become: otherHandler,   // replace the active handler
  unstashAll?: true,       // re-enqueue all stashed messages after switching
  events?: TypedEvent[],
}
```

### Stash — defer the current message

```ts
return {
  state,
  stash: true,  // hold this message for later; re-process after unstashAll
}
```

### Domain Events

Use `emit(topic, payload)` to construct typed events. Each event is published to its declared topic on the system event bus.

```ts
import { emit, createTopic } from '../system/index.ts'

const OrderPlacedTopic = createTopic<{ orderId: string }>('orders.placed')

// In handler:
return {
  state: newState,
  events: [emit(OrderPlacedTopic, { orderId: '123' })],
}
```

## Context Services

The `context` object passed to `handler` and `lifecycle` provides the following services.

### `context.self`
A reference to this actor (`ActorRef<M>`). Useful to pass as a `replyTo` address in messages.

### `context.log`
Structured logger. Messages are emitted to the system log topic.
```ts
context.log.info('something happened', { detail: 42 })
// levels: debug | info | warn | error
```

### `context.messageHeaders()`
Returns the headers attached to the message currently being processed. Empty object when none were set. Headers are plain string key-value pairs, compatible with W3C traceparent and similar propagation formats.
```ts
const traceId = context.messageHeaders()['traceparent']
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

// Cancel all
context.timers.cancelAll()

// Check
context.timers.isActive('heartbeat') // boolean
```
Timers are automatically cancelled when the actor stops or restarts.

### `context.spawn` / `context.stop`
Create and stop child actors. Children are automatically watched — their termination is delivered as a `terminated` lifecycle event.
```ts
const childRef = context.spawn('worker', workerDef, workerInitialState)
context.stop(childRef) // request graceful stop
```

### `context.watch` / `context.unwatch`
Watch any actor (not just children) for termination. When the watched actor stops, a `terminated` lifecycle event is delivered.
```ts
context.watch(someRef)
context.unwatch(someRef)
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
context.pipeToSelf(
  fetch('/api/data').then(r => r.json()),
  (data) => ({ type: 'dataLoaded', data }),        // onSuccess → M
  (err)  => ({ type: 'dataFailed', error: err }),  // onFailure → M
)
return { state: { ...state, loading: true } }
```

- If the actor has stopped by the time the promise resolves, the result is silently discarded.
- Cancellation is the caller's responsibility (e.g., use `AbortController` inside the promise).

### `context.publish` / `context.subscribe` / `context.unsubscribe` / `context.deleteTopic`
Pub-sub on the system event stream. `subscribe` takes an adapter function that maps the raw event into the actor's message type, so events are processed through the normal message handler.
```ts
import { createTopic } from '../system/index.ts'
const MyTopic = createTopic<{ value: number }>('my-topic')

// Publishing
context.publish(MyTopic, { value: 42 })

// Subscribing
context.subscribe(MyTopic, (event) => ({ type: 'externalData', value: event.value }))

// Unsubscribing
context.unsubscribe(MyTopic)

// Remove the topic's subscriber map entry (use after publishing a terminal event
// on a short-lived topic to prevent accumulation)
context.deleteTopic(MyTopic)
```

Plain strings work as topics too (typed as `EventTopic<unknown>`). Use `createTopic<T>()` for compile-time payload safety.

## Lifecycle Events

If you provide a `lifecycle` handler, it receives:

| Event | When |
|---|---|
| `{ type: 'start' }` | Actor has started (or restarted after supervision). Resources can be acquired here. |
| `{ type: 'stopping' }` | Graceful shutdown started — mailbox is draining (only if `shutdown.drain` is enabled). |
| `{ type: 'stopped' }` | This actor is shutting down (after children have stopped). |
| `{ type: 'terminated', ref, reason, error? }` | A watched or child actor has terminated. `reason` is `'stopped'` or `'failed'`. |

```ts
lifecycle: (state, event, context) => {
  if (event.type === 'start') {
    context.log.info('actor started')
  }
  if (event.type === 'terminated') {
    context.log.warn(`${event.ref.name} died: ${event.reason}`)
  }
  return { state }
}
```

## Supervision

Control what happens when `handler` throws:

```ts
// Stop on failure (default)
supervision: { type: 'stop' }

// Restart: reset state, re-fire start lifecycle, keep processing
supervision: { type: 'restart' }

// Bounded restart: max 3 failures within 10 seconds, then stop
supervision: { type: 'restart', maxRetries: 3, withinMs: 10_000 }

// Restart with exponential backoff: starts at 500ms, doubles each failure, capped at 30s
supervision: { type: 'restart', backoffMs: 500, maxBackoffMs: 30_000 }
```

## Mailbox Backpressure

Limit the number of messages queued to an actor. Overflowed messages go to dead letters.

```ts
const def: ActorDef<Msg, State> = {
  handler: /* ... */,
  mailbox: {
    capacity: 1000,
    overflowStrategy: 'drop-newest', // or 'drop-oldest'. Default: 'drop-newest'
    onOverflow: (dropped) => console.warn('dropped', dropped), // optional hook
  },
}
```

## Graceful Shutdown

By default an actor stops immediately when asked. Enable drain mode to finish processing queued messages first:

```ts
const def: ActorDef<Msg, State> = {
  handler: /* ... */,
  shutdown: {
    drain: true,         // process remaining mailbox messages before stopping
    timeoutMs: 5_000,    // force-close after 5 s if not drained
  },
}
```

When `drain` is `true`, the actor receives a `stopping` lifecycle event before `stopped`, giving it a chance to react before the final teardown.

## Interceptors

Interceptors wrap the message handler in a pipeline — useful for logging, metrics, tracing, or authorization. The first interceptor in the array is the outermost wrapper.

```ts
import type { Interceptor } from '../system/index.ts'

const loggingInterceptor: Interceptor<Msg, State> = (state, message, context, next) => {
  context.log.debug('handling', { type: message.type })
  const result = next(state, message)
  context.log.debug('handled', { type: message.type })
  return result
}

const def: ActorDef<Msg, State> = {
  handler: /* ... */,
  interceptors: [loggingInterceptor],
}
```

Interceptors survive `become` switches (the new handler is re-wrapped) and reset on supervision restart.

## Persistence

Provide a persistence adapter to snapshot state across process restarts. `load()` is called before the `start` lifecycle event, so the `start` handler always receives the last durable state and can re-initialize non-serializable resources on top of it.

```ts
import type { PersistenceAdapter } from '../system/index.ts'

const myAdapter: PersistenceAdapter<CounterState> = {
  load: async () => {
    const raw = await db.get('counter-state')
    return raw ? JSON.parse(raw) : undefined
  },
  save: async (state) => {
    await db.set('counter-state', JSON.stringify(state))
  },
}

const def: ActorDef<CounterMsg, CounterState> = {
  handler: /* ... */,
  persistence: myAdapter,
}
```

`save(state)` is called after every successfully processed message. Save errors are logged as warnings and do not crash the actor. Note: stash contents and the active `become` variant are not persisted — encode behavioral state you need to survive restarts into `S`.

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

## Resource Acquisition Pattern

Use the `start` lifecycle event to acquire resources and `stopped` to release them:

```ts
const def: ActorDef<Msg, State> = {
  lifecycle: (state, event, context) => {
    if (event.type === 'start') {
      const resource = acquireSomething()
      context.log.info('resource acquired')
      return { state: { ...state, resource } }
    }
    if (event.type === 'stopped' && state.resource) {
      releaseSomething(state.resource)
      context.log.info('resource released')
    }
    return { state }
  },

  handler: (state, msg, ctx) => {
    // use state.resource
    return { state }
  },
}
```

The `start` event fires on initial startup and again on every supervision restart, so resources are always re-acquired cleanly.

## Plugins

Actors are deployed as plugins. A `PluginDef<M, S>` is an `ActorDef<M, S>` plus plugin metadata:

| Field | Required | Description |
|---|---|---|
| `id` | **yes** | Unique plugin identifier. |
| `version` | **yes** | Semantic version string. |
| `initialState` | **yes** | The state value passed to `spawn` when the plugin actor is started. |
| `dependencies` | no | IDs of plugins that must be active before this one loads. |
| `description` | no | Human-readable description. |

The plugin root **is** the actor. All `ActorDef` fields (`handler`, `lifecycle`, `supervision`, `mailbox`, etc.) apply directly. Activation runs through `lifecycle.start`; deactivation through `lifecycle.stopped`.

### Minimal Plugin

```ts
import { createPluginSystem } from '../system/index.ts'
import type { PluginDef } from '../system/index.ts'

type PingMsg = { type: 'ping' }

const pingPlugin: PluginDef<PingMsg, null> = {
  id: 'ping',
  version: '1.0.0',
  initialState: null,
  handler: (state, msg, ctx) => {
    ctx.log.info('ping received')
    return { state }
  },
}

const system = await createPluginSystem({ plugins: [pingPlugin] })
```

### Plugin with Child Actors

The typical pattern is for the plugin root to spawn child actors in `lifecycle.start` and stop them in `lifecycle.stopped`. The plugin's `handler` can reconfigure children at runtime.

```ts
import { onLifecycle, createPluginSystem } from '../system/index.ts'
import type { ActorDef, PluginDef, ActorContext } from '../system/index.ts'

type WorkerMsg = { type: 'process'; payload: string }
type PluginMsg = { type: 'config'; workerCount: number }

const spawnWorkers = (count: number, ctx: ActorContext<PluginMsg>) => {
  const workerDef: ActorDef<WorkerMsg, null> = {
    handler: (state, msg, ctx) => {
      ctx.log.info(`processing: ${msg.payload}`)
      return { state }
    },
  }
  for (let i = 0; i < count; i++) {
    ctx.spawn(`worker-${i}`, workerDef, null)
  }
}

const myPlugin: PluginDef<PluginMsg, null> = {
  id: 'my-plugin',
  version: '1.0.0',
  initialState: null,

  lifecycle: onLifecycle({
    start(state, ctx) {
      spawnWorkers(3, ctx)
      ctx.log.info('plugin activated')
      return { state }
    },
    stopped(state, ctx) {
      ctx.log.info('plugin deactivating')
      return { state }
    },
  }),

  handler: (state, msg, ctx) => {
    // reconfigure at runtime
    return { state }
  },
}
```

### Plugin System API

```ts
const system = await createPluginSystem({ plugins: [/* startup plugins */] })

// Load a plugin at runtime
await system.use(myPlugin)

// Unload
await system.unloadPlugin('my-plugin')

// Restart the plugin actor (same def)
await system.reloadPlugin('my-plugin')

// Hot-reload from disk (re-imports the module, picks up code changes)
await system.hotReloadPlugin('my-plugin', './path/to/my-plugin.ts')

// Inspect
system.listPlugins()           // LoadedPlugin[]
system.getPluginStatus('id')   // LoadedPlugin | undefined
```

### `onLifecycle` Helper

`onLifecycle` reduces the boilerplate of a full lifecycle handler by letting you declare only the events you care about:

```ts
import { onLifecycle } from '../system/index.ts'

lifecycle: onLifecycle({
  start(state, ctx) {
    // runs on actor start / supervision restart
    return { state }
  },
  stopping(state, ctx) {
    // runs when graceful drain begins (if shutdown.drain is true)
    return { state }
  },
  stopped(state, ctx) {
    // runs on actor stop
    return { state }
  },
  terminated(state, ctx, event) {
    // runs when a watched actor dies; event.ref, event.reason, event.error
    return { state }
  },
})
```

Unhandled event types fall through to a default `return { state }`. The helper is valid for both plain `ActorDef` actors and `PluginDef` plugins.
