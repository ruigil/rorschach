# Product Context

## Why This Project Exists
Building modern AI/agentic systems requires agents that can communicate asynchronously, react to events, and coordinate without tight coupling. Rorschach provides the foundational event bus infrastructure for such systems.

## Problems It Solves
- **Decoupled agent communication** — Agents don't need to know about each other; they communicate through events
- **Observability** — Full distributed tracing (traceId + parentId) lets you reconstruct entire causal chains
- **Reliability** — Error isolation ensures one misbehaving handler doesn't break the system
- **Type safety** — Compile-time guarantees on event contracts between agents
- **Extensibility** — Middleware pipeline and agent abstraction make it easy to add cross-cutting concerns

## How It Works
1. Create an `EventBus<MyEvents>` with your typed event map
2. Extend `BaseAgent` to create agents that subscribe to and emit events
3. Wire agents to the bus and call `start()`
4. Submit events — agents react asynchronously, with full trace propagation

## User Experience Goals
- Zero boilerplate to create a new agent (just override `setup()`)
- Type-safe event contracts — IDE auto-complete for event types and payloads
- Easy debugging via trace reconstruction and logging middleware
