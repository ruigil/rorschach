# System Patterns

## Architecture: Event-Driven Agent System

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Orchestrator │     │  Worker(s)  │     │   Logger    │
│    Agent     │     │   Agent     │     │   Agent     │
└──────┬───┬──┘     └──┬──────┬──┘     └──────┬──────┘
       │   │           │      │               │
       │   │     emit  │      │  emit         │  on("*")
       │   └───────────┼──────┼───────────────┤
       │               │      │               │
    ┌──┴───────────────┴──────┴───────────────┴──┐
    │            EventBus (in-memory)             │
    │  ┌─────────────────────────────────┐       │
    │  │  Middleware Pipeline             │       │
    │  │  logging → [filter] → handlers  │       │
    │  └─────────────────────────────────┘       │
    └────────────────────────────────────────────┘
```

## Core Patterns

### 1. Event Envelope
Every event is wrapped in an envelope containing metadata:
- `id` — unique per event
- `type` — event key (e.g., `"task:assigned"`)
- `payload` — typed data
- `source` — emitting agent id
- `traceId` — groups all causally-related events
- `parentId` — the event that directly caused this one
- `correlationId` — ties request↔reply pairs
- `replyTo` — reply channel for request pattern

### 2. Typed Event Maps
Event contracts are defined as TypeScript `type` aliases mapping event type strings to payload shapes. The `EventBus<TEvents>` generic enforces compile-time type safety on both `emit()` and `on()`.

### 3. Koa-Style Middleware
Middleware wraps every event dispatch as `(event, next) => Promise<void>`. Code before `await next()` runs pre-dispatch; code after runs post-dispatch. Not calling `next()` short-circuits the pipeline (event is dropped).

### 4. Concurrent Handler Dispatch
Handlers are invoked via `Promise.allSettled()` — one failing handler never blocks others. Errors are logged but don't propagate.

### 5. Request/Reply via Correlation
`bus.request()` generates a unique `correlationId` and temporary reply channel, emits the request, and awaits a reply on that channel. `bus.reply()` echoes back the `correlationId` and `traceId`. Timeout support included.

### 6. Automatic Trace Propagation
`BaseAgent` tracks which event is currently being handled (`currentContext`). When the agent emits a new event inside a handler, `traceId` and `parentId` are automatically inherited, creating a causal tree without manual wiring.

### 7. Agent Lifecycle & Factory Pattern
`BaseAgent` is used as a **factory** — agents return the `BaseAgent(...)` result directly (or spread it with extra methods). Agent-specific behavior is wired via the `setup` callback, and state lives in closures. No internal `base` field or manual method passthrough.

```ts
// Simple agent: return BaseAgent directly
const MyAgent = (options) => BaseAgent<MyEvents>({
  ...options,
  setup: (agent) => {
    agent.on("event", async (e) => { ... });
  }
});

// Extended agent: spread + extra methods
const MyAgent = (options) => {
  const agent = BaseAgent<MyEvents>({ ...options, setup: ... });
  return { ...agent, getLog, ... };
};
```

Subscriptions are tracked and auto-cleaned on stop.

### 8. Cognitive Capabilities (ModelProvider + CognitiveAgent)
Agents can be given LLM-powered reasoning via the `ModelProvider` interface and `CognitiveAgent` factory:

```
┌─────────────────────────────────┐
│        CognitiveAgent           │
│  ┌────────────┐ ┌────────────┐  │
│  │ BaseAgent   │ │ModelProvider│ │
│  │ (events)    │ │ (LLM calls)│ │
│  └─────┬──────┘ └──────┬─────┘  │
│        │               │        │
│  think() chat() decide()        │
│  summarize() generate()         │
└────────┬────────────────────────┘
         │ emits cognitive:thinking/complete/error
    ┌────┴──────────────────────────┐
    │          EventBus              │
    └────────────────────────────────┘
```

- **ModelProvider** — Provider-agnostic interface: `complete(messages) → CompletionResult`
- **OpenRouterProvider** — First implementation; OpenAI-compatible API, 200+ models, zero deps
- **CognitiveAgent** — Composes BaseAgent + ModelProvider; adds think/chat/decide/summarize
- **CognitiveEvents** — All LLM calls emit events for observability (thinking, complete, error)
- **System prompt** — Prepended to every call, separate from conversation history
- **History management** — Trimmed FIFO when exceeding maxHistoryLength

### 9. Interface Layer (InterfaceAgent + Adapters)
Agents receive external inputs via a **stateless interface gateway** that bridges transport protocols to the internal event bus:

```
External World          Interface Agent           EventBus           Cognitive Agent
                        (stateless gateway)                           (owns sessions)
                                                                      
HTTP POST ──► Adapter ──► request("interface:chat") ─────────►  on("interface:chat")
                                                                      │
                                                                chatSession(sessionId, msg)
              Adapter ◄── awaits reply  ◄──────────────────────  reply({ content })
                                                                      
WebSocket ──► Adapter ──► same request   ──────────────────────► same session
              Adapter ◄── push via "interface:push" ◄───────── any agent can push

                         ┌─────────────────────────────────────────────────┐
                         │  InterfaceAgent                                │
                         │   • Manages adapters (start/stop lifecycle)      │
                         │   • Inbound: adapter → bus.request → reply      │
                         │   • Outbound: bus "interface:push" → adapters   │
                         │   • NO session state, NO cognitive capabilities  │
                         └─────────────────────────────────────────────────┘
```

- **InterfaceAdapter** — Transport-agnostic interface: `start(handler)`, `stop()`, `send?()`, `broadcast?()`
- **HttpAdapter** — Simplex (request/response only); `Bun.serve()`, POST /chat, GET /health
- **WebSocketAdapter** — Duplex (supports server-initiated push); Bun native WS, session→connection mapping
- **Session centralization** — All conversation history lives in CognitiveAgent, not in interface
- **Push pattern** — Any agent emits `"interface:push"` → InterfaceAgent routes to duplex adapters
- **InterfaceEvents** — Observability: message:received, response:sent, push:sent, error, adapter lifecycle

### 10. CognitiveAgent Session-Based Chat
Multi-user/multi-channel conversations share a centralized session store:

```ts
// Session methods on CognitiveAgent:
chatSession(sessionId, message)       // Multi-turn with session isolation
chatSessionRaw(sessionId, message)    // Full CompletionResult
getSessionHistory(sessionId)          // Read session history
clearSession(sessionId)               // Clear specific session
listSessions()                        // List all active sessions
```

Internal storage: `Map<string, ChatMessage[]>`. Existing `chat()` / `chatRaw()` still work (default session).

### 11. Memory Module (MemoryAgent + VectorStore + GraphStore)
Agents gain persistent semantic memory and optional knowledge graph:

```
┌──────────────────────────────────────────────────────┐
│                    MemoryAgent                       │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │ BaseAgent   │  │ VectorStore  │  │ GraphStore  │  │
│  │ (events)    │  │ (ruvector)   │  │ (pure-JS)   │  │
│  └─────┬──────┘  └──────┬───────┘  └──────┬──────┘  │
│        │                │                 │          │
│  store/recall/remember  │     link/cypher/traverse   │
│  forget/storeConversation    communities/pageRank    │
│                  ┌──────┴───────────┐                │
│                  │ EmbedderProvider  │                │
│                  │ (LocalNGram)      │                │
│                  └──────────────────┘                │
└────────┬─────────────────────────────────────────────┘
         │ emits memory:stored/recalled/forgotten/linked/queried/error
    ┌────┴──────────────────────────┐
    │          EventBus              │
    └────────────────────────────────┘
```

- **VectorStoreProvider** — Provider-agnostic interface: `insert`, `search`, `get`, `delete`, `count`
- **EmbedderProvider** — Text → vector: `embed(text)`, `embedBatch(texts)`
- **GraphStoreProvider** — Full graph DB: nodes, edges, Cypher queries, path finding, PageRank, communities
- **RuvectorStore** — VectorStoreProvider backed by ruvector's native HNSW VectorDb
- **RuvectorEmbedder** — EmbedderProvider using ruvector's LocalNGramProvider (zero deps, works offline)
- **RuvectorGraphStore** — Pure-JS in-memory graph with simplified Cypher parser (MATCH/WHERE/RETURN)
- **MemoryAgent methods**: `store()`, `recall()`, `remember()` (RAG), `forget()`, `storeConversation()`
- **Graph methods** (when graphStore provided): `link()`, `related()`, `cypher()`, `shortestPath()`, `communities()`, `pageRank()`
- **MemoryEvents** — Full observability: stored, recalled, forgotten, linked, queried, error
- **RAG bridge** — `remember(query)` returns formatted context string for LLM prompt injection

## Key Design Decisions
- **In-memory first** — Simple, fast; same interface can later back onto Redis/NATS
- **`type` over `interface`** for event maps — TS interfaces lack implicit index signatures needed for `Record<string, unknown>` constraint
- **`async` wrapper on all handlers** in `Promise.allSettled` — catches both sync throws and async rejections
- **Priority sort** — Handlers are sorted descending by priority in the array before concurrent dispatch
- **Factory pattern everywhere** — BaseAgent, CognitiveAgent, OpenRouterProvider all use factory functions (no classes for agents)
- **Provider abstraction** — ModelProvider type makes it trivial to swap OpenRouter for Anthropic, Ollama, etc.
- **Zero new deps for cognitive** — Uses Bun's native fetch() for HTTP
