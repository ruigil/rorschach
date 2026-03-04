/** Barrel export for the memory module. */

export { MemoryAgent } from "./memory-agent";
export type { MemoryAgentOptions } from "./memory-agent";

export { RuvectorStore, RuvectorEmbedder, RuvectorGraphStore } from "./ruvector-store";
export type {
  RuvectorStoreOptions,
  RuvectorEmbedderOptions,
  RuvectorGraphStoreOptions,
} from "./ruvector-store";

export type {
  MemoryEntry,
  MemorySearchResult,
  VectorStoreProvider,
  VectorSearchResult,
  VectorEntry,
  EmbedderProvider,
  GraphStoreProvider,
  GraphNode,
  GraphEdge,
  CypherResult,
  PathResult,
  MemoryEvents,
} from "./types";
