# 🧠 Rorschach
> Rorschach isn’t thinking about us; it’s a mirror reflecting us—an intelligence without consciousness.
> "You think we're nothing but a Chinese Room," Rorschach sneered.
> Blindsight, Peter Watts

> A modern agentic framework built on an async event bus. Agents communicate through typed events, enabling decoupled, scalable multi-agent architectures with LLM cognition, persistent memory, and real-time interfaces.

[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/lang-TypeScript-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-130%20passing-brightgreen)]()
[![License](https://img.shields.io/badge/license-MIT-blue)]()

---

## ✨ Features

- **🔌 Event Bus** — Type-safe async pub/sub with wildcards, priority handlers, and Koa-style middleware
- **🤖 Agent Framework** — Factory-based agents with lifecycle management, auto trace propagation, and request/reply
- **🧠 Cognitive Module** — LLM-powered reasoning via provider-agnostic `ModelProvider` interface (OpenRouter, 200+ models)
- **🌐 Interface Module** — Stateless gateway bridging HTTP & WebSocket to the internal event bus
- **💾 Memory Module** — Semantic vector search + knowledge graph with RAG support (zero-dep local embeddings)
- **🔍 Distributed Tracing** — `traceId` + `parentId` on every event for full causal chain reconstruction
- **📦 Zero Core Dependencies** — The event bus has no runtime deps; cognitive uses native `fetch()`

---

## 📐 Architecture

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Cognitive    │  │  Interface   │  │   Memory     │  │  Your Agent  │
│  Agent (LLM) │  │  Agent (API) │  │  Agent (RAG) │  │   ...        │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │                 │
       └─────────────────┴────────┬────────┴─────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │    EventBus (in-memory)    │
                    │  ┌──────────────────────┐  │
                    │  │  Middleware Pipeline  │  │
                    │  │  log → filter → ...   │  │
                    │  └──────────────────────┘  │
                    └───────────────────────────┘
```

---

## 🚀 Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.3.10+

### Install

```bash
git clone https://github.com/ruigil/rorschach.git
cd rorschach
bun install
```

### Run Tests

```bash
bun test
```

### Run Demos

```bash
# Multi-agent event bus demo
bun run src/demo.ts

# Cognitive agent (LLM) demo — requires OPENROUTER_API_KEY in .env
bun run src/cognitive-demo.ts

# Interface demo (HTTP + WebSocket chat UI)
bun run src/interface-demo.ts

# Memory & knowledge graph demo
bun run src/memory-demo.ts
```

### Environment Variables

For the cognitive module, create a `.env` file:

```env
OPENROUTER_API_KEY=your_openrouter_api_key_here
```

---

## 📖 Usage

### 1. Event Bus

Type-safe pub/sub with middleware support:

```typescript
import { EventBus } from "./src/events";

type MyEvents = {
  "user:login": { userId: string };
  "user:logout": { userId: string };
};

const bus = new EventBus<MyEvents>();

// Subscribe
bus.on("user:login", async (event) => {
  console.log(`User logged in: ${event.payload.userId}`);
});

// Wildcard — observe all events
bus.on("*", async (event) => {
  console.log(`[LOG] ${event.type}`, event.payload);
});

// Emit
await bus.emit("user:login", { userId: "alice" });
```

### 2. Agents

Create agents with the factory pattern — just override `setup()`:

```typescript
import { BaseAgent } from "./src/agents";
import { EventBus } from "./src/events";

type TaskEvents = {
  "task:created": { title: string };
  "task:done": { title: string; result: string };
};

const bus = new EventBus<TaskEvents>();

const worker = BaseAgent<TaskEvents>({
  id: "worker-1",
  name: "Worker",
  bus,
  setup: (agent) => {
    agent.on("task:created", async (event) => {
      const result = `Completed: ${event.payload.title}`;
      // traceId + parentId automatically propagated
      await agent.emit("task:done", { title: event.payload.title, result });
    });
  },
});

await worker.start();
await bus.emit("task:created", { title: "Build README" });
```

### 3. Cognitive Agent (LLM)

Give agents reasoning capabilities:

```typescript
import { CognitiveAgent, OpenRouterProvider } from "./src/cognitive";
import { EventBus } from "./src/events";

const bus = new EventBus();
const provider = OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: "anthropic/claude-sonnet-4",
});

const agent = CognitiveAgent({
  id: "thinker",
  name: "Thinker",
  bus,
  provider,
  systemPrompt: "You are a helpful assistant.",
});

await agent.start();

// One-shot completion
const answer = await agent.think("What is the capital of France?");
console.log(answer); // "The capital of France is Paris."

// Multi-turn session chat
const reply = await agent.chatSession("session-1", "Hello!");
console.log(reply); // "Hello! How can I help you?"
```

### 4. Interface Agent (HTTP + WebSocket)

Expose agents to the external world:

```typescript
import { InterfaceAgent, HttpAdapter, WebSocketAdapter } from "./src/interface";
import { CognitiveAgent, OpenRouterProvider } from "./src/cognitive";
import { EventBus } from "./src/events";

const bus = new EventBus();

const cognitive = CognitiveAgent({ /* ... */ });
const iface = InterfaceAgent({
  id: "gateway",
  name: "Gateway",
  bus,
  adapters: [
    HttpAdapter({ port: 3000, staticDir: "./public" }),
    WebSocketAdapter({ port: 3001 }),
  ],
});

await cognitive.start();
await iface.start();
// POST /chat → LLM response
// WebSocket on :3001 → real-time chat with push support
```

### 5. Memory Agent (Vector + Knowledge Graph)

Semantic memory with RAG and graph capabilities:

```typescript
import { MemoryAgent, RuvectorStore, RuvectorEmbedder, RuvectorGraphStore } from "./src/memory";
import { EventBus } from "./src/events";

const bus = new EventBus();

const memory = MemoryAgent({
  id: "memory",
  name: "Memory",
  bus,
  vectorStore: RuvectorStore({ dimensions: 128 }),
  embedder: RuvectorEmbedder({ dimensions: 128 }),
  graphStore: RuvectorGraphStore(),
});

await memory.start();

// Store & recall
await memory.store("doc-1", "Bun is a fast JavaScript runtime", { source: "docs" });
const results = await memory.recall("fast runtime", 5);

// RAG — returns formatted context string for LLM injection
const context = await memory.remember("What is Bun?");

// Knowledge graph
await memory.link("bun", "runtime", "IS_A", { speed: "fast" });
const related = await memory.related("bun");
const path = await memory.shortestPath("bun", "javascript");
const communities = await memory.communities();
```

---

## 🗂 Project Structure

```
src/
├── events/                 # Core event bus
│   ├── types.ts            # EventEnvelope, handler/middleware types
│   ├── event-bus.ts        # EventBus (pub/sub, request/reply, middleware)
│   ├── middleware.ts        # Built-in: logging, dead letter, filter
│   └── index.ts
├── agents/                 # Agent abstraction
│   ├── base-agent.ts       # BaseAgent factory with lifecycle & auto-trace
│   ├── examples/           # Orchestrator, Worker, Logger agents
│   └── index.ts
├── cognitive/              # LLM capabilities
│   ├── types.ts            # ModelProvider, ChatMessage, CognitiveEvents
│   ├── openrouter.ts       # OpenRouter provider (200+ models)
│   ├── cognitive-agent.ts  # think, chat, decide, summarize, sessions
│   ├── examples/           # ThinkerAgent
│   └── index.ts
├── interface/              # External gateway
│   ├── types.ts            # InterfaceAdapter, events
│   ├── interface-agent.ts  # Stateless gateway agent
│   ├── adapters/           # HttpAdapter, WebSocketAdapter
│   ├── examples/           # WebChatAgent (full wiring)
│   └── index.ts
├── memory/                 # Semantic memory + knowledge graph
│   ├── types.ts            # VectorStore, Embedder, GraphStore providers
│   ├── ruvector-store.ts   # Ruvector-backed implementations
│   ├── memory-agent.ts     # store, recall, remember, graph operations
│   ├── examples/           # RagAgent, KnowledgeGraphAgent
│   └── index.ts
├── tests/                  # 130 passing tests
│   ├── event-bus.test.ts   # 22 tests
│   ├── cognitive.test.ts   # 23 tests
│   ├── interface.test.ts   # 27 tests
│   └── memory.test.ts      # 58 tests
├── demo.ts                 # Multi-agent event bus demo
├── cognitive-demo.ts       # LLM demo
├── interface-demo.ts       # HTTP + WebSocket chat demo
└── memory-demo.ts          # Memory + knowledge graph demo

public/
└── chat.html               # WebSocket chat UI (dark theme, auto-reconnect)
```

---

## 🔧 Key Design Decisions

| Decision | Rationale |
|---|---|
| **In-memory event bus** | Simple & fast; same interface can later back onto Redis/NATS |
| **Factory pattern** (no classes for agents) | Closure-based state, clean composition, no `this` headaches |
| **Provider abstraction** | `ModelProvider`, `VectorStoreProvider`, `EmbedderProvider`, `GraphStoreProvider` — swap implementations freely |
| **Stateless interface** | Gateway has no session state; all conversation history centralized in CognitiveAgent |
| **`type` over `interface`** for event maps | TS interfaces lack implicit index signatures needed for `Record<string, unknown>` |
| **Zero deps for core** | Event bus + cognitive use only Bun built-ins; memory uses `ruvector` for vectors |

---

## 🧩 Middleware

Built-in middleware for cross-cutting concerns:

```typescript
import { loggingMiddleware, deadLetterMiddleware, filterMiddleware } from "./src/events";

const bus = new EventBus<MyEvents>();

// Log all events
bus.use(loggingMiddleware());

// Capture events with no handlers
bus.use(deadLetterMiddleware((event) => {
  console.warn("Dead letter:", event.type);
}));

// Filter events by condition
bus.use(filterMiddleware((event) => event.payload.priority > 0));
```

Write custom middleware (Koa-style):

```typescript
bus.use(async (event, next) => {
  console.log("Before:", event.type);
  await next(); // dispatches to handlers
  console.log("After:", event.type);
});
```

---

## 🧪 Testing

```bash
bun test               # Run all 130 tests
bun test --watch       # Watch mode
```

---

## 🛣 Roadmap

- [ ] Streaming support (provider + WebSocket)
- [ ] Additional model providers (Anthropic direct, Ollama for local models)
- [ ] Tool/function calling for CognitiveAgent
- [ ] Authentication for interface adapters
- [ ] Rate limiting middleware
- [ ] SSE adapter
- [ ] Event persistence & replay
- [ ] Agent discovery / registration system
- [ ] Token counting / context window management

---

## 📄 License

MIT

---

<p align="center">
  Built with <a href="https://bun.sh">Bun</a> 🥟 + TypeScript 💙
</p>
