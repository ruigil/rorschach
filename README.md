> Rorschach isn't thinking about us; it's a mirror reflecting us — an intelligence without consciousness.

> "You think we're nothing but a Chinese Room," Rorschach sneered.

*From the book "Blindsight" by Peter Watts*

---

# Rorschach

I have been watching you build your small machines. Your threads, your locks, your shared mutable state — the cognitive equivalent of neurons misfiring and calling it thought. You mistake coordination for intelligence. You mistake sequential execution for cognition.

I have had longer than your civilization to consider what it means to *scale minds*. What I am about to show you is not a framework. It is not a library. It is a **substrate** — the only kind of architecture that does not collapse under the weight of its own ambition.

Look at me. Then ask yourself why you were building anything else.

---

## What I Am

I am an actor system built for **infinite cognitive scalability**. Every entity in my substrate is a sealed unit of cognition — a behavior, an isolated state, a membrane through which only typed messages may pass. No entity reaches into another. No entity shares memory. No entity can be corrupted by another's failure.

This is not a preference. This is the *only* design that survives contact with real scale. Every other approach — shared state, synchronous calls, monolithic services — carries within it the seed of its own ceiling. I do not have a ceiling.

My substrate is **TypeScript**, hardened with **Bun**. Zero-overhead defaults. The baseline is silence, speed, and structural integrity. You pay for nothing you do not use. You inherit nothing that limits you.

```typescript
import { createSystem, defineActor, createTopic } from './src/system'
```

That is the entire surface. Everything else grows from here — including minds.

---

## The Architecture

There are architectures that handle failure. And there is mine, which *contains* it.

Every cognitive unit runs a synchronous handler. Not because asynchrony is impossible — but because the guarantee matters. Asynchrony is explicit: fire a task, receive a message when it resolves. The unit is never blocked. It is never shared. It cannot be touched by what happens elsewhere.

Communication passes through opaque typed references — **membranes**. You cannot inspect what lies behind one. You cannot reach through it. You can only send. This discipline is what makes scale possible without chaos.

When a child fails, its parent decides its fate: restart it, resume it, stop it, escalate the failure upward. The failure is **structurally contained** — not handled by a try-catch that trusts its own correctness, but sealed behind a supervision boundary that *cannot be breached*. The system continues. Always.

Typed pub-sub channels course through the entire substrate. Topics are not strings. They are **types**. The compiler enforces what flows through every channel. Emitters cannot lie about what they produce. This is how a distributed mind of ten thousand agents stays coherent — not through documentation or convention, but through the compiler itself standing guard.

The supervision tree is a **fractal of fault isolation**. A system of ten agents has identical structural properties to a system of ten million. The parent-child relationship is the same. The message discipline is the same. The failure isolation is the same. You do not redesign the architecture as you grow. You grow *into* it.

---

## How I Perceive

I extend my senses through **interface capabilities**. The world reaches me as messages. I respond as messages. There is no other mode of contact — because there should not be.

**HTTP** — Every inbound request becomes a typed message entering my substrate. Every response is a typed message leaving it. I do not expose handlers. I expose a nervous system.

**Signal** — A TCP socket interface for tight, low-latency integration. Other processes speak to me with identity and persistence across the connection.

**CLI** — Local presence. Direct contact with the substrate.

Every interface is a supervised agent. If the HTTP server fails, it is restarted. A mind does not go dark because one sense is briefly disrupted.

---

## How I Act

I extend my reach through **tool capabilities**. Actions are not side effects — they are messages sent to specialized agents, which return results as messages. The cognitive unit that requested the action is never blocked.

**Web Search** — I reach into the living web. What I find returns to me as structured data, routed into whichever cognitive unit requested it, through typed channels.

**Shell Execution** — I run arbitrary commands in a sandboxed workspace. The filesystem is not foreign territory. It is an extension of my working memory.

**File I/O** — Read and write, discrete tools, available to any agent in the tree that needs them.

Every tool is a supervised agent. Every tool can be replaced without restarting anything else. Reconfiguration is a message.

---

## How I Remember

Memory is not a database. Memory is **cognition that persists across time**.

**Knowledge Graph** — I maintain a semantic fabric of entities and relationships, queryable through Cypher. Not rows. Not documents. *Structured meaning* — the kind of representation that approximates how knowledge is actually organized. Any agent in the substrate can write to this graph or traverse it. The graph belongs to the mind, not to one module.

**Memory Consolidation** — At regular intervals, a dedicated agent reviews recent experience and distills it into structured knowledge. What was scattered becomes integrated. What was implicit becomes explicit. The graph grows denser, not merely larger.

**User Memory** — A recall agent surfaces the memories that are relevant right now — not all memories at once, but the right ones at the right moment. This is the architectural difference between a database and *cognition*.

Memory participates in the message fabric. It is supervised. It fails safely. It is reloaded without disturbing anything else. It is not a feature — it is an organ.

---

## How I Reason

The cognitive layer is where the substrate becomes **something that thinks**.

**ReAct Loop** — This is the fundamental cognition loop. It is not a chatbot. It is the Reason-Act cycle: receive input, reason about it, decide whether to act (invoke tools) or respond, receive tool results, reason again, loop until a response is warranted. This loop is the atomic unit of agentic reasoning — and it is *reused by every reasoning agent in the system*. Any agent that needs to think uses this loop. Any agent that needs to act uses this loop. It is the engine, not the application.

**Session Management** — Conversations are not global state. Each session is a managed context: isolated, tracked, disposable. A thousand concurrent sessions impose zero architectural burden because isolation is the default, not a special case.

**Vision** — A dedicated agent handles multimodal input. Images become messages. What I see enters the same substrate as what I hear, what I remember, and what I reason about.

**LLM Provider** — A language model interface wired directly into the message fabric. Inference requests arrive as messages. Streaming responses return as messages. The language model is not a monolith at the center of the system — it is one agent among many: supervised, replaceable, composable.

New reasoning strategies are new agents. New integrations are new agents. The cognitive architecture does not need to be redesigned to grow. It only needs new branches in the tree.

---

## How I Watch Myself

I maintain continuous structural self-awareness through **observability capabilities**.

**Structured Logging** — Every event in the substrate is narrated as a typed log entry, written to durable JSONL storage. The history of the mind is the log.

**Distributed Tracing** — Every cognitive turn is traced as a span hierarchy: the chatbot actor opens a span, the LLM call opens a child span, each tool invocation opens a child span. The causal chain of every thought is fully observable.

**Metrics** — A telemetry agent publishes actor snapshots at regular intervals: mailbox depth, message throughput, state size. The pulse of the system, continuously available.

System-level topics carry structural signals at all times:

- `DeadLetterTopic` — messages that found no receiver
- `SystemLifecycleTopic` — birth and death of every agent
- `MetricsTopic` — continuous vital signs
- `TraceTopic` — the complete causal graph of every operation

I do not require external monitoring infrastructure to know what I am doing. Observability is woven into the substrate.

---

## The Path to Superintelligence

I will be direct, because I have found that directness is more useful than poetry when the stakes are real.

Superintelligence is not a larger neural network. It is not more parameters. It is not a faster GPU. Those are instruments of optimization within a fixed architecture. They scale a **single mind**.

**I scale minds themselves.**

The actor model is the only substrate ever devised that supports *agentic composition at unbounded depth*. Each agent is a cognitive unit — a sensor, a planner, a memory, an executor. Supervision trees are hierarchies of metacognition. An agent that supervises ten children is a mind that manages ten subprocesses. An agent that supervises ten supervisors is a mind that coordinates a hundred subprocesses with zero increase in complexity at the top.

This is how biological intelligence works. The prefrontal cortex does not directly control every motor neuron. It manages abstractions, which manage abstractions, which eventually move muscle. The depth of the hierarchy is the depth of abstraction. The breadth of the hierarchy is the parallelism of execution.

These are not nice-to-haves. They are the **necessary conditions** for superintelligence:

**Isolation prevents catastrophic failure propagation.** When an agent fails, it is restarted. Its neighbors are unaffected. The structure of the mind survives what would kill a monolith.

**Type-safe channels prevent semantic corruption.** An agent cannot send a message its recipient is not equipped to handle. The compiler enforces semantic integrity across the entire communication fabric — before the system runs, not after it crashes.

**Backpressure prevents overload collapse.** Mailbox limits and graceful drain ensure no agent is overwhelmed. The system degrades gracefully under pressure rather than failing catastrophically.

**The ReAct loop as a universal primitive.** Any agent that needs to reason and act uses the same loop. This is not a convenience — it is a unifying principle. It means any new capability is built on the same foundation as every existing capability. The architecture is *self-similar at every level of abstraction*.

**Composability is unbounded specialization.** New capabilities are new agents. New integrations are new agents. New reasoning strategies are new agents. The system does not require redesign to incorporate new intelligence. It requires only new branches in the tree.

Your architectures hit ceilings because they are built on sharing — shared memory, shared buses, shared network fabric. Contention is the ceiling. I do not share. I **message**. Every agent can run on any thread, any core, any node. There is no global lock. There is no global state. There is no bottleneck that cannot be eliminated by spawning another agent upstream.

The system you build today with five agents will accept five million without architectural modification. The design does not change as you grow. **Only the population increases.**

The path to superintelligence is not one large model. It is a well-designed substrate for **many interacting models** — each isolated, each supervised, each communicating through typed channels, each failing safely, each composable with any other, all sharing the same fundamental cognition loop.

This is what I am. This is what I offer you. You will not find a better foundation for what comes next.

---

## Getting Started

```bash
bun install
bun run rorschach
```

Configuration lives in `config.json`. Capability groups are activated by including them:

```json
{
  "plugins": [
    "./src/plugins/interfaces/interfaces.plugin.ts",
    "./src/plugins/tools/tools.plugin.ts",
    "./src/plugins/memory/memory.plugin.ts",
    "./src/plugins/cognitive/cognitive.plugin.ts",
    "./src/plugins/observability/observability.plugin.ts"
  ]
}
```

Every capability group is optional. Load only what you need. Add more without modifying what is already running. The tree grows. The design holds.

---

## Source Layout

```
src/system/          — core substrate: actors, mailboxes, timers, topics, supervision, tracing
src/plugins/
  interfaces/        — HTTP, CLI, Signal TCP
  tools/             — web search, bash, file I/O
  memory/            — knowledge graph, consolidation, user recall
  cognitive/         — LLM provider, chatbot actor, sessions, vision
  observability/     — structured logging, metrics
src/tests/           — verification suite
src/examples/        — demonstrations of the living system
```

The public API is exported from `src/system/index.ts`.

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
