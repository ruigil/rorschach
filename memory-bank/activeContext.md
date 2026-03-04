# Active Context

## Current State
The core event bus, agent framework, cognitive capabilities, interface module, and memory module are fully implemented and tested.

## What Was Just Built

### Memory Module (`src/memory/`) — Vector memory + knowledge graph for agents
- **types.ts** — VectorStoreProvider, EmbedderProvider, GraphStoreProvider, MemoryEntry, MemorySearchResult, GraphNode, GraphEdge, CypherResult, PathResult, MemoryEvents
- **ruvector-store.ts** — Three provider factories:
  - `RuvectorStore()` — VectorStoreProvider backed by ruvector's native VectorDb (HNSW indexing)
  - `RuvectorEmbedder()` — EmbedderProvider using ruvector's LocalNGramProvider (zero external deps)
  - `RuvectorGraphStore()` — GraphStoreProvider: pure-JS in-memory graph with Cypher query parser, BFS shortest path, PageRank, community detection
- **memory-agent.ts** — MemoryAgent factory: BaseAgent + VectorStore + Embedder + optional GraphStore
- **examples/rag-agent.ts** — RAG Agent combining MemoryAgent + CognitiveAgent
- **examples/knowledge-graph-agent.ts** — Knowledge graph with Cypher queries, hybrid vector+graph search
- **index.ts** — Barrel exports

### Key Design Decisions for Memory
- **Provider abstractions** — VectorStoreProvider, EmbedderProvider, GraphStoreProvider (like ModelProvider for LLMs)
- **Pure-JS graph engine** — Custom in-memory graph with simplified Cypher parser (MATCH/WHERE/RETURN), BFS path finding, PageRank, community detection — avoids native module compatibility issues
- **ruvector for vectors** — Uses ruvector's native VectorDb for HNSW similarity search, EmbeddingService for text→vector
- **Optional graph** — MemoryAgent works with just vector store; graph capabilities are additive
- **remember() as RAG bridge** — Returns formatted context string ready for LLM prompt injection
- **Memory events** — memory:stored, memory:recalled, memory:forgotten, memory:linked, memory:queried, memory:error
- **Isolated storage** — Each VectorDb instance uses a unique storagePath to prevent cross-test contamination

### Tests — 130 passing (22 EventBus + 23 Cognitive + 27 Interface + 58 Memory)

### Demo — `src/memory-demo.ts`
- Full stack: KnowledgeGraphAgent with facts, relationships, Cypher queries, graph traversal, hybrid search, PageRank, community detection

## Previous Work (Still Active)
1. **EventBus** — Type-safe async pub/sub with wildcards, priority, middleware, and request/reply
2. **Middleware** — Logging, dead letter, and filter middleware (Koa-style composable)
3. **BaseAgent** — Agent factory with lifecycle, auto trace propagation, and convenience helpers
4. **Example Agents** — Orchestrator, Worker, Logger
5. **CognitiveAgent** — LLM-powered think/chat/decide/summarize + session-based chat
6. **OpenRouter** — Provider for 200+ models via fetch
7. **InterfaceAgent** — Stateless gateway: HTTP + WebSocket adapters, request/reply delegation
8. **Chat UI** — WebSocket chat interface (public/chat.html)
9. **Demos** — demo.ts (multi-agent), cognitive-demo.ts (LLM), interface-demo.ts (web chat), memory-demo.ts (memory + graph)

## Next Steps (Potential)
- Add streaming support to the provider interface + WebSocket streaming
- Add more model providers (Anthropic direct, Ollama for local models)
- Add tool/function calling support to CognitiveAgent
- Add authentication to interface adapters
- Add rate limiting middleware for interface endpoints
- Add event persistence / replay capability
- Add agent discovery / registration system
- Upgrade to ONNX MiniLM embedder for higher quality semantic search
- Add native @ruvector/graph-node support when Bun compatibility improves
