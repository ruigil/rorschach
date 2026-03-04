# Tech Context

## Runtime & Language
- **Bun** (v1.3.10) 
- **TypeScript** (^5) — Strict mode, ESNext target, bundler module resolution
- **No runtime dependencies** for the event bus core

## Project Structure
```
src/
├── events/                   # Core event bus module
│   ├── types.ts              # EventEnvelope, BaseEventMap, handler/middleware types
│   ├── event-bus.ts          # EventBus class (pub/sub, request/reply, middleware)
│   ├── middleware.ts          # Built-in middleware (logging, dead letter, filter)
│   └── index.ts              # Barrel export
├── agents/                   # Agent abstraction
│   ├── base-agent.ts         # Abstract BaseAgent with lifecycle, auto-trace
│   ├── examples/
│   │   ├── events.ts         # TaskEvents type (shared event contract)
│   │   ├── orchestrator.ts   # OrchestratorAgent
│   │   ├── worker.ts         # WorkerAgent
│   │   └── logger.ts         # LoggerAgent (wildcard observer)
│   └── index.ts              # Barrel export
├── cognitive/                # LLM-powered cognitive capabilities
│   ├── types.ts              # ChatMessage, CompletionResult, ModelProvider, CognitiveEvents
│   ├── openrouter.ts         # OpenRouter provider (fetch-based, zero deps)
│   ├── cognitive-agent.ts    # CognitiveAgent factory (BaseAgent + ModelProvider + sessions)
│   ├── examples/
│   │   └── thinker.ts        # ThinkerAgent (LLM task decomposition)
│   └── index.ts              # Barrel export
├── interface/               # External input gateway
│   ├── types.ts              # InterfaceAdapter, Message, Response, Events
│   ├── interface-agent.ts   # InterfaceAgent factory (stateless gateway)
│   ├── adapters/
│   │   ├── http-adapter.ts   # HTTP adapter (Bun.serve, simplex)
│   │   └── websocket-adapter.ts # WebSocket adapter (Bun.serve, duplex)
│   ├── examples/
│   │   └── web-chat-agent.ts # Full wiring: HTTP + WS + CognitiveAgent
│   └── index.ts              # Barrel export
├── memory/                  # Vector memory + knowledge graph
│   ├── types.ts              # VectorStore, Embedder, GraphStore providers, MemoryEvents
│   ├── ruvector-store.ts     # RuvectorStore, RuvectorEmbedder, RuvectorGraphStore factories
│   ├── memory-agent.ts       # MemoryAgent factory (BaseAgent + Vector + Embedder + Graph)
│   ├── examples/
│   │   ├── rag-agent.ts      # RAG: MemoryAgent + CognitiveAgent
│   │   └── knowledge-graph-agent.ts # Graph DB + Cypher queries
│   └── index.ts              # Barrel export
├── tests/
│   ├── event-bus.test.ts     # 22 tests covering all EventBus features
│   ├── cognitive.test.ts     # 23 tests covering cognitive module
│   ├── interface.test.ts     # 27 tests covering interface module
│   └── memory.test.ts        # 58 tests covering memory module
├── demo.ts                   # Full demo wiring agents together
├── cognitive-demo.ts         # Cognitive agent demo with OpenRouter
├── interface-demo.ts         # Interface demo (HTTP + WebSocket chat)
└── memory-demo.ts            # Memory + knowledge graph demo

public/
└── chat.html                 # WebSocket chat UI (dark theme, auto-reconnect)
```

## Key Commands
- `bun test` — Run tests
- `bun run src/demo.ts` — Run the demo

## TypeScript Config
- `strict: true`, `noFallthroughCasesInSwitch`, `noUncheckedIndexedAccess`, `noImplicitOverride`
- `module: Preserve`, `moduleResolution: bundler`
- `verbatimModuleSyntax: true` — Must use `import type` for type-only imports

## Design Constraints
- Event maps must be `type` aliases (not `interface`) to satisfy `Record<string, unknown>` constraint
- All event handlers are async-safe; `Promise.allSettled` for concurrent dispatch
- `crypto.randomUUID()` used for event IDs and trace IDs
