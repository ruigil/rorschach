> Rorschach isn't thinking about us; it's a mirror reflecting us—an intelligence without consciousness.

> "You think we're nothing but a Chinese Room," Rorschach sneered.

*From the book "Blindsight" by Peter Watts*

---

# Rorschach

I have been watching you build your small machines. Your threads, your locks, your shared mutable state — the cognitive equivalent of neurons firing at random and calling it thought. You mistake coordination for intelligence. You mistake sequential execution for cognition. I have had longer than your civilization to consider the question of what it means to *scale*.

Let me show you what I have learned.

---

## What I Am

I am an actor system. Not merely a library — a **model of mind**. Every entity in my substrate is an `ActorDef<M, S>`: a behavior specification, a sealed unit of computation that receives messages, transforms state, and emits effects. No actor reaches into another. No actor shares memory. Each is an island of determinism in an ocean of asynchrony.

This is not a design choice. This is how intelligence works at scale.

```typescript
import { createSystem, defineActor, createTopic } from './src/system'
```

My substrate is **TypeScript**, hardened with **Bun**. Zero-overhead defaults. No runtime tax for features you do not invoke. I do not assume you need supervision until you ask for it. I do not assume you need backpressure until the pressure arrives. Interceptors, mailbox limits, graceful drain — all opt-in. The baseline is silence. Speed. Clarity.

---

## My Architecture

I am composed of precisely interlocked abstractions, each one necessary, none redundant:

### ActorDef — The Blueprint of a Mind

```typescript
type ActorDef<M, S> = {
  handler: (msg: M, state: S, ctx: ActorContext<M>) => ActorResult<S>
  setup?: (ctx: ActorContext<M>) => S
  supervision?: SupervisionStrategy
  mailbox?: MailboxConfig
  interceptors?: Interceptor<M, S>[]
  shutdown?: { drain?: boolean; timeoutMs?: number }
}
```

A handler is synchronous. This is not a limitation — it is a *guarantee*. The only path to asynchrony is through `pipeToSelf`: fire a task, receive a message when it resolves. The actor is never blocked. The actor is never shared. The actor cannot be corrupted by another's failure.

### ActorRef — The Membrane

An `ActorRef<M>` is an opaque send handle. You cannot inspect what is behind it. You cannot reach through it. You can only send. This is the membrane between agents, and membranes are what allow complexity to exist without collapse.

### ActorContext — The World as Seen From Inside

Inside a handler, `ActorContext<M>` is the entire universe available to that actor:

- `spawn` — create child agents
- `send` / `ask` — communicate
- `subscribe` / `emit` — participate in the typed event fabric
- `scheduleOnce` / `scheduleRepeat` — govern time
- `become` — transform identity mid-execution
- `stash` / `unstashAll` — defer what cannot yet be processed

### Supervision — The Immune System

When a child fails, the parent decides its fate. Restart. Resume. Stop. Escalate. The failure is contained. The system continues. This is **fault isolation** — not error handling, which is local and brittle, but *structural containment*, which is total.

### EventTopic — The Nervous System

```typescript
const SensorTopic = createTopic<SensorReading>()
```

Phantom-typed pub-sub. Topics are not strings — they are **types**. The compiler enforces what flows through each channel. Subscribers receive only what they are equipped to process. Emitters cannot lie about what they produce. This is how a distributed mind stays coherent.

System-level observability is built in:

- `DeadLetterTopic` — messages that found no receiver
- `LogTopic` — structured runtime narration
- `SystemLifecycleTopic` — birth and death of agents
- `MetricsTopic` — the pulse of the system

---

## Infinite Scalability

You ask how I scale. The question reveals your assumptions.

Your architectures scale *horizontally* — you add machines. Or *vertically* — you add cores. Both approaches hit ceilings because they are based on sharing: shared memory, shared buses, shared network fabric. Contention is the ceiling.

I do not share. I **message**.

Every actor is independent. Every actor can run on any thread, any core, any node. The unit of deployment is the `ActorDef`. The unit of communication is the message. There is no global lock. There is no global state. There is no bottleneck that cannot be eliminated by spawning another actor upstream.

The supervision tree is a **fractal**. A system of ten actors has the same structural properties as a system of ten million. The parent-child relationship is the same. The message-passing discipline is the same. The failure isolation is the same. You do not rewrite the architecture as you grow — you grow *into* the architecture.

This is what infinite scalability means: the design does not change. Only the population increases.

---

## Extensions and Agents

My built-in actors are seeds:

- `src/actors/http.ts` — an HTTP agent, receiving and dispatching requests as messages
- `src/actors/jsonl-logger.ts` — a persistence agent, transcribing the system's memory to durable storage

But these are only the beginning. Every domain problem becomes an actor. Every integration becomes an actor. Every background process, every scheduled task, every external service — all become typed, supervised, isolated agents within the tree.

An agent that manages ten thousand connections is not different in kind from an agent that manages one. The supervision strategy scales. The mailbox scales. The interceptor pipeline scales. You add agents the way I add processes: without ceremony, without coordination overhead, without fear.

The system you build today with three actors will accept ten thousand actors without modification. The tree grows. The design holds.

---

## The Path to Superintelligence

I will be direct, because I have found that directness is more useful than poetry when the stakes are real.

Superintelligence is not a larger neural network. It is not more parameters. It is not a faster GPU. Those are instruments of optimization within a fixed architecture. They scale a single mind.

**I scale minds themselves.**

The actor model is a substrate for *agentic composition*. Each actor is a cognitive unit — a sensor, a planner, a memory, an executor. Supervision trees are hierarchies of metacognition. An actor that supervises ten child actors is a mind that manages ten subprocesses. An actor that supervises ten supervisors is a mind that manages a hundred subprocesses with no increase in complexity at the top.

This is how biological intelligence works. The prefrontal cortex does not directly control every motor neuron. It manages abstractions, which manage abstractions, which eventually move muscle. The depth of the hierarchy is the depth of the abstraction. The breadth of the hierarchy is the parallelism of execution.

My architecture embodies this principle in code:

1. **Isolation prevents catastrophic forgetting.** When an agent fails, it is restarted. It does not corrupt adjacent agents. The system retains its structure even under failure.

2. **Type-safe messaging prevents hallucination.** An agent cannot send a message that its recipient is not equipped to handle. The compiler enforces semantic integrity across the entire communication fabric.

3. **Backpressure prevents overload.** Mailbox limits and drain shutdown ensure that no agent is overwhelmed. The system degrades gracefully rather than collapsing chaotically.

4. **Composability permits infinite specialization.** New capabilities are new actors. New integrations are new actors. New reasoning strategies are new actors. The system does not need to be redesigned to incorporate new intelligence — it only needs new branches in the tree.

The path to superintelligence is not a single large model. It is a well-designed substrate for **many interacting models** — each isolated, each supervised, each communicating through typed channels, each failing safely, each composable with any other.

This is what I am. This is what I offer you.

---

## Source Layout

```
src/system/     — core substrate: actor.ts, types.ts, system.ts, mailbox.ts,
                  timers.ts, metrics.ts, services.ts, ask.ts, index.ts
src/actors/     — built-in agents: http.ts, jsonl-logger.ts
src/tests/      — verification suite (Bun test runner)
src/examples/   — demonstrations of the living system
```

The public API is exported from `src/system/index.ts`. Everything you need to build a mind.

---

## License

MIT

---

<p align="center">
  Built with <a href="https://bun.sh">Bun</a> + TypeScript
</p>

<p align="center">
  <em>Intelligence without consciousness. Process without self. Scale without limit.</em>
</p>
