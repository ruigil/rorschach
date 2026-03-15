
## Pipe / Message Routing Combinators — Deep Dive

### The Problem: Manual Wiring Boilerplate

Looking at your actual codebase, every inter-actor connection today requires manual wiring. Here are the three patterns you already use, and the boilerplate each demands:

**Pattern 1: EventStream adapter (inside an actor)**
```typescript
// JSONL logger subscribes to system logs
context.subscribe(LogTopic, (event) => {
  return { type: 'log', event: event as LogEvent }  // manual adapter
})
```

**Pattern 2: External subscriber forwarding to an actor**
```typescript
// http-example.ts — external code subscribes and manually processes
system.subscribe('text-handler', 'system/http', (event) => {
  const { clientId, text } = event as { clientId: string; text: string }
  console.log(`📨 Received: "${text}"`)
})
```

**Pattern 3: Direct `ref.send()` bridging between actors**
```typescript
// If actor A needs to forward transformed messages to actor B,
// the handler must manually call targetRef.send(transform(msg))
```

Each of these works, but they share common weaknesses:
- **No type safety** — the EventStream is `unknown`-typed, requiring manual casts everywhere
- **Lifecycle-unaware** — if the target actor dies, the subscription keeps delivering into the void (or dead-letters)
- **Verbose** — every connection requires 3-5 lines of identical plumbing
- **Not composable** — you can't chain transformations, filters, or routing decisions declaratively

---

### What Are Routing Combinators?

Routing combinators are **reusable, composable functions that describe how messages flow between actors**. They sit between the raw EventStream infrastructure and actor business logic. Think of them as typed pipes with built-in lifecycle awareness.

There are two layers to this:

---

### Layer 1: `pipe` — Declarative Actor-to-Actor Wiring

A `pipe` connects one actor's output (domain events) to another actor's input (messages), with a typed transformation in between.

```typescript
// ─── Pipe definition ───
type Pipe<In, Out> = {
  /** Transform the source event into the target's message type. Return undefined to filter/skip. */
  transform: (event: In) => Out | undefined
}

// ─── On ActorContext ───
context.pipe<In>(
  source: ActorIdentity,       // actor whose domain events to consume
  pipe: Pipe<In, M>,           // transform + filter
): void

// Or from outside the actor system:
system.pipe<In, Out>(
  source: ActorIdentity,
  target: ActorRef<Out>,
  pipe: Pipe<In, Out>,
): () => void  // returns unsubscribe
```

**Concrete example — replacing today's manual wiring:**

```typescript
// TODAY (http-example.ts):
system.subscribe('text-handler', 'system/http', (event) => {
  const { clientId, text } = event as { clientId: string; text: string }
  console.log(`📨 Received: "${text}"`)
})

// WITH PIPE:
system.pipe('system/http', loggerRef, {
  transform: (event: { clientId: string; text: string }) => ({
    type: 'log-ws-message' as const,
    clientId: event.clientId, 
    text: event.text,
  })
})
```

**What `pipe` gives you over raw `subscribe`:**
- The subscription is **auto-cleaned** when either source or target dies (via watch integration)
- The transform function serves as both **adapter and filter** (return `undefined` to skip)
- It's a single declarative statement instead of manual subscribe + cast + forward

**How it works internally:** `pipe` is syntactic sugar over:
1. `context.watch(source)` — so we know when to clean up
2. `eventStream.subscribe(self.name, source.name, ...)` — the actual subscription
3. The transform function is applied, and the result (if not `undefined`) is sent to the target via `mailbox.enqueue`

---

### Layer 2: Routing Combinators — Composable Message Dispatch Patterns

Beyond simple point-to-point pipes, there are recurring **routing topologies** that show up in every actor system. Rather than implementing these as ad-hoc logic inside handlers, they can be provided as ready-made actor definitions (or higher-order functions that produce `ActorDef`s):

#### 1. **Router** — One-to-many with a strategy

```typescript
type RouterStrategy<M> =
  | { type: 'round-robin' }
  | { type: 'broadcast' }
  | { type: 'random' }
  | { type: 'consistent-hash'; hashFn: (msg: M) => string }
  | { type: 'content-based'; route: (msg: M) => string }  // returns target name

const createRouter = <M>(
  strategy: RouterStrategy<M>,
  routees: ActorRef<M>[],
): ActorDef<M | RouterControl, RouterState<M>>
```

**Use case:** You spawn 5 worker actors to process jobs in parallel. The router distributes incoming work across them.

```typescript
const workers = Array.from({ length: 5 }, (_, i) =>
  ctx.spawn(`worker-${i}`, workerDef, null)
)

const router = ctx.spawn('job-router', createRouter(
  { type: 'round-robin' },
  workers,
), initialRouterState)

// Now just send to the router — it handles distribution
router.send({ type: 'process', payload: data })
```

#### 2. **Splitter** — One message in, multiple messages out to different targets

```typescript
const createSplitter = <In>(
  routes: Array<{
    predicate: (msg: In) => boolean
    target: ActorRef<any>
    transform: (msg: In) => any
  }>
): ActorDef<In, null>
```

**Use case:** An HTTP actor produces events. Some go to the logger, some to a metrics collector, some to a business logic processor.

```typescript
const splitter = ctx.spawn('event-splitter', createSplitter<WsEvent>([
  {
    predicate: (e) => e.type === 'ws:message',
    target: processorRef,
    transform: (e) => ({ type: 'process', text: e.text }),
  },
  {
    predicate: () => true,  // all events
    target: metricsRef,
    transform: (e) => ({ type: 'metric', event: e.type }),
  },
]), null)
```

#### 3. **Aggregator** — Collect messages from multiple sources, emit when complete

```typescript
const createAggregator = <In, Out>(opts: {
  isComplete: (buffer: In[]) => boolean
  aggregate: (buffer: In[]) => Out
  target: ActorRef<Out>
  timeoutMs?: number
}): ActorDef<In, AggregatorState<In>>
```

**Use case:** Scatter-gather pattern — send a request to 3 services, aggregate all responses, forward the combined result.

#### 4. **Throttle / Rate Limiter**

```typescript
const createThrottle = <M>(opts: {
  maxPerSecond: number
  target: ActorRef<M>
  onDrop?: 'dead-letter' | 'buffer'
}): ActorDef<M, ThrottleState<M>>
```

**Use case:** Your HTTP actor gets a burst of WebSocket messages. You want to limit how fast they hit the downstream business logic actor.

---

### Key Design Decision: Actors vs. Functions?

There's a choice to make here:

| Approach | Pros | Cons |
|---|---|---|
| **Routing as actors** (spawn a router actor) | Fully lifecycle-managed, supervisable, has state, composable via the existing hierarchy | Extra actor overhead per routing node |
| **Routing as context helpers** (e.g., `context.pipe()`) | Zero overhead, no extra actor, cleaner API | No state, not supervisable, lifecycle management is implicit |
| **Routing as pure functions** (combinators that produce `ActorDef`s) | Maximum flexibility — user spawns them when needed, can compose/customize | Slightly more verbose to use |

**My recommendation for your system:** A hybrid approach:

1. **`context.pipe()`** — Add as a context helper for the common case (actor A's events → actor B's mailbox with a transform). This is the 80% case and should be frictionless.

2. **Router/Splitter/Aggregator/Throttle** — Provide as **factory functions** that return `ActorDef`s (like your existing `createHttpActor` and `createJsonlLoggerActor` patterns). Users spawn them like any other actor. This keeps routing composable and supervisable without adding new primitives to the core.

This means the core system only gains one new method (`context.pipe`), while the routing patterns live in a `src/actors/routing/` directory alongside your existing actor library — clean separation.

---

### What This Would Look Like in Practice

Here's your JSONL logger example rewritten with pipes and a splitter:

```typescript
const system = createActorSystem()

// Spawn actors
const httpRef = system.spawn('http', createHttpActor({ port: 3000 }), httpState)
const loggerRef = system.spawn('logger', createJsonlLoggerActor({ filePath: LOG_FILE }), loggerState)
const metricsRef = system.spawn('metrics', metricsDef, metricsState)

// Declarative wiring — replaces all the manual subscribe boilerplate
const processorRef = system.spawn('processor', {
  setup: (state, ctx) => {
    // Pipe HTTP domain events into this actor, transformed into our message type
    ctx.pipe('system/http', {
      transform: (event: { clientId: string; text: string }) => ({
        type: 'ws-input' as const,
        ...event,
      })
    })
    return state
  },
  handler: (state, msg, ctx) => {
    // Pure business logic — no wiring concerns
    return { state }
  },
})
```

---

### Summary

| Feature | Scope | Implementation |
|---|---|---|
| `context.pipe()` | Core system (context helper) | Watch-aware EventStream subscription with typed transform |
| `createRouter()` | Actor library (`src/actors/routing/`) | Actor def factory with round-robin/broadcast/hash strategies |
| `createSplitter()` | Actor library | Actor def factory with predicate-based multi-target dispatch |
| `createAggregator()` | Actor library | Actor def factory with buffering + completion predicate |
| `createThrottle()` | Actor library | Actor def factory using timers for rate limiting |

The `context.pipe()` is the foundational piece — the routing actors are built on top of it and the existing primitives. Would you like me to go deeper on any specific combinator, or shall we discuss implementation details for `context.pipe()`?
