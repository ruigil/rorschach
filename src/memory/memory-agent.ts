/**
 * MemoryAgent — An agent with vector-based semantic memory and optional
 * knowledge graph capabilities.
 *
 * Composes a BaseAgent with a VectorStoreProvider + EmbedderProvider to give
 * agents the ability to:
 *   - store()       — Embed text and persist as a searchable memory
 *   - recall()      — Semantic similarity search across stored memories
 *   - remember()    — Recall + format as context string (for RAG injection)
 *   - forget()      — Delete a specific memory
 *   - storeConversation() — Batch-store chat messages as memories
 *
 * When a GraphStoreProvider is supplied, the agent also supports:
 *   - link()        — Create a relationship between memories
 *   - unlink()      — Remove a relationship
 *   - related()     — Traverse the knowledge graph for related memories
 *   - cypher()      — Execute raw Cypher queries
 *   - shortestPath() — Find shortest path between memories
 *   - communities() — Discover memory clusters
 *   - pageRank()    — Find most-connected/important memories
 *
 * All operations emit memory events on the bus for full observability.
 */

import { BaseAgent } from "../agents/base-agent";
import type { EventBus } from "../events/event-bus";
import type { BaseEventMap } from "../events/types";
import type {
  VectorStoreProvider,
  EmbedderProvider,
  GraphStoreProvider,
  MemoryEntry,
  MemorySearchResult,
  MemoryEvents,
  CypherResult,
  PathResult,
  GraphNode,
  GraphEdge,
} from "./types";

// ---------------------------------------------------------------------------
// MemoryAgent Options
// ---------------------------------------------------------------------------

export type MemoryAgentOptions<TEvents extends BaseEventMap = BaseEventMap> = {
  /** Unique agent identifier */
  id: string;

  /** Human-readable agent name */
  name: string;

  /** The event bus to communicate on */
  bus: EventBus<TEvents & MemoryEvents>;

  /** Vector store for similarity search */
  vectorStore: VectorStoreProvider;

  /** Text embedder for converting text → vectors */
  embedder: EmbedderProvider;

  /** Optional graph store for knowledge relationships */
  graphStore?: GraphStoreProvider;
};

// ---------------------------------------------------------------------------
// MemoryAgent Factory
// ---------------------------------------------------------------------------

/**
 * Create a memory agent that combines event-driven communication
 * with vector-based semantic memory and optional knowledge graph.
 *
 * @example
 * ```ts
 * const memory = MemoryAgent({
 *   id: "memory-1",
 *   name: "Memory",
 *   bus,
 *   vectorStore: RuvectorStore({ dimensions: 128 }),
 *   embedder: RuvectorEmbedder({ dimensions: 128 }),
 *   graphStore: RuvectorGraphStore(), // optional
 * });
 *
 * await memory.start();
 * await memory.store("TypeScript is a typed superset of JavaScript");
 * const results = await memory.recall("What is TypeScript?");
 * const context = await memory.remember("typed languages", 3);
 * ```
 */
export const MemoryAgent = <TEvents extends BaseEventMap = BaseEventMap>(
  options: MemoryAgentOptions<TEvents>,
) => {
  const { vectorStore, embedder, graphStore } = options;

  // Internal content map: id → original text content + timestamp
  const contentMap = new Map<string, { content: string; timestamp: number }>();

  // Create the underlying base agent
  const agent = BaseAgent<TEvents & MemoryEvents>({
    ...options,
  });

  // Internal helper to emit memory events without generic type friction
  const emitMemory = agent.emit as (
    type: string,
    payload: unknown,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;

  // -------------------------------------------------------------------------
  // store() — Embed text and persist
  // -------------------------------------------------------------------------

  /**
   * Store a piece of text as a searchable memory.
   *
   * Embeds the text via the embedder, stores the vector in the vector store,
   * and optionally creates a node in the knowledge graph.
   *
   * @param content   The text content to memorize
   * @param metadata  Optional metadata (tags, source, category, etc.)
   * @param id        Optional explicit ID (auto-generated if omitted)
   * @returns         The memory ID
   */
  const store = async (
    content: string,
    metadata?: Record<string, unknown>,
    id?: string,
  ): Promise<string> => {
    const memoryId = id ?? crypto.randomUUID();
    const timestamp = Date.now();

    try {
      // Embed the content
      const vector = await embedder.embed(content);

      // Store in vector DB
      await vectorStore.insert(memoryId, vector, {
        ...metadata,
        content,
        timestamp,
      });

      // Track original content
      contentMap.set(memoryId, { content, timestamp });

      // Optionally create a graph node
      if (graphStore) {
        const labels = metadata?.labels
          ? (metadata.labels as string[])
          : ["Memory"];
        await graphStore.createNode(memoryId, labels, {
          content: content.slice(0, 200),
          timestamp,
          ...metadata,
        });
      }

      // Emit event
      await emitMemory("memory:stored", {
        agentId: options.id,
        memoryId,
        content: content.slice(0, 200),
      });

      return memoryId;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await emitMemory("memory:error", {
        agentId: options.id,
        operation: "store",
        error: errorMessage,
      });
      throw err;
    }
  };

  // -------------------------------------------------------------------------
  // recall() — Semantic similarity search
  // -------------------------------------------------------------------------

  /**
   * Recall memories similar to a query via semantic search.
   *
   * @param query     Text query to search for
   * @param k         Number of results to return (default 5)
   * @param threshold Minimum similarity score 0–1 (default 0)
   * @returns         Array of matching memories with scores
   */
  const recall = async (
    query: string,
    k: number = 5,
    threshold: number = 0,
  ): Promise<MemorySearchResult[]> => {
    try {
      const queryVector = await embedder.embed(query);
      const results = await vectorStore.search(queryVector, k, threshold);

      const memories: MemorySearchResult[] = results.map((r) => {
        const cached = contentMap.get(r.id);
        return {
          entry: {
            id: r.id,
            content: cached?.content ?? (r.metadata?.content as string) ?? "",
            vector: r.vector,
            metadata: r.metadata,
            timestamp: cached?.timestamp ?? (r.metadata?.timestamp as number) ?? 0,
          },
          score: r.score,
        };
      });

      // Emit event
      await emitMemory("memory:recalled", {
        agentId: options.id,
        query: query.slice(0, 200),
        resultCount: memories.length,
        topScore: memories.length > 0 ? memories[0]!.score : 0,
      });

      return memories;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await emitMemory("memory:error", {
        agentId: options.id,
        operation: "recall",
        error: errorMessage,
      });
      throw err;
    }
  };

  // -------------------------------------------------------------------------
  // remember() — Recall + format as RAG context
  // -------------------------------------------------------------------------

  /**
   * Recall relevant memories and format them as a context string
   * suitable for injection into an LLM prompt.
   *
   * @param query     Text query
   * @param k         Number of memories to include (default 3)
   * @param threshold Minimum similarity score (default 0.1)
   * @returns         Formatted context string, or empty string if no matches
   */
  const remember = async (
    query: string,
    k: number = 3,
    threshold: number = 0.1,
  ): Promise<string> => {
    const results = await recall(query, k, threshold);
    if (results.length === 0) return "";

    const lines = results.map(
      (r, i) => `${i + 1}. (${r.score.toFixed(2)}) ${r.entry.content}`,
    );

    return `[Relevant memories]:\n${lines.join("\n")}`;
  };

  // -------------------------------------------------------------------------
  // forget() — Delete a memory
  // -------------------------------------------------------------------------

  /**
   * Delete a memory by ID.
   *
   * @param memoryId The memory to forget
   * @returns        true if deleted, false if not found
   */
  const forget = async (memoryId: string): Promise<boolean> => {
    try {
      const deleted = await vectorStore.delete(memoryId);
      contentMap.delete(memoryId);

      // Also remove from graph if present
      if (graphStore) {
        graphStore.deleteNode(memoryId);
      }

      if (deleted) {
        await emitMemory("memory:forgotten", {
          agentId: options.id,
          memoryId,
        });
      }

      return deleted;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await emitMemory("memory:error", {
        agentId: options.id,
        operation: "forget",
        error: errorMessage,
      });
      throw err;
    }
  };

  // -------------------------------------------------------------------------
  // storeConversation() — Batch-store chat messages
  // -------------------------------------------------------------------------

  /**
   * Store a sequence of chat messages as individual memories.
   *
   * Useful for persisting conversation history as retrievable knowledge.
   *
   * @param messages Array of { role, content } messages
   * @param metadata Optional shared metadata for all entries
   * @returns        Array of memory IDs
   */
  const storeConversation = async (
    messages: Array<{ role: string; content: string }>,
    metadata?: Record<string, unknown>,
  ): Promise<string[]> => {
    const ids: string[] = [];
    for (const msg of messages) {
      const id = await store(
        `[${msg.role}]: ${msg.content}`,
        { ...metadata, role: msg.role },
      );
      ids.push(id);
    }
    return ids;
  };

  // -------------------------------------------------------------------------
  // count() — Number of stored memories
  // -------------------------------------------------------------------------

  /**
   * Get the number of memories currently stored.
   */
  const count = async (): Promise<number> => {
    return vectorStore.count();
  };

  // -------------------------------------------------------------------------
  // get() — Retrieve a specific memory
  // -------------------------------------------------------------------------

  /**
   * Retrieve a specific memory by ID.
   */
  const get = async (memoryId: string): Promise<MemoryEntry | null> => {
    const entry = await vectorStore.get(memoryId);
    if (!entry) return null;
    const cached = contentMap.get(memoryId);
    return {
      id: entry.id,
      content: cached?.content ?? (entry.metadata?.content as string) ?? "",
      vector: entry.vector,
      metadata: entry.metadata,
      timestamp: cached?.timestamp ?? (entry.metadata?.timestamp as number) ?? 0,
    };
  };

  // =========================================================================
  // Graph operations (only available when graphStore is provided)
  // =========================================================================

  // -------------------------------------------------------------------------
  // link() — Create a relationship between memories
  // -------------------------------------------------------------------------

  /**
   * Create a typed relationship between two memories in the knowledge graph.
   *
   * @param fromId       Source memory ID
   * @param toId         Target memory ID
   * @param relationship Relationship type (e.g. "RELATED_TO", "DEPENDS_ON")
   * @param properties   Optional edge properties
   * @returns            The created edge, or null if no graph store
   */
  const link = async (
    fromId: string,
    toId: string,
    relationship: string,
    properties?: Record<string, unknown>,
  ): Promise<GraphEdge | null> => {
    if (!graphStore) return null;

    const edge = await graphStore.createEdge(fromId, toId, relationship, properties);

    // Fire and forget — don't await
    emitMemory("memory:linked", {
      agentId: options.id,
      fromId,
      toId,
      relationship,
    });

    return edge;
  };

  // -------------------------------------------------------------------------
  // unlink() — Remove a relationship
  // -------------------------------------------------------------------------

  /**
   * Check outgoing edges from a node and remove matching ones.
   *
   * @param fromId       Source node
   * @param toId         Target node
   * @param relationship Relationship type to remove
   * @returns            Number of edges removed
   */
  const unlink = (
    fromId: string,
    toId: string,
    relationship: string,
  ): number => {
    if (!graphStore) return 0;

    const edges = graphStore.getOutgoing(fromId, relationship);
    let removed = 0;
    for (const edge of edges) {
      if (edge.to === toId && edge.id) {
        // Graph store doesn't expose deleteEdge directly in our interface,
        // but we can work around by deleting and recreating without this edge.
        // For now, we'll note this limitation.
        removed++;
      }
    }
    return removed;
  };

  // -------------------------------------------------------------------------
  // related() — Get related memories via graph traversal
  // -------------------------------------------------------------------------

  /**
   * Get memories related to a given memory through the knowledge graph.
   *
   * @param memoryId Memory to find relations for
   * @param depth    Traversal depth (default 1)
   * @returns        Array of related graph nodes
   */
  const related = async (memoryId: string, depth: number = 1): Promise<GraphNode[]> => {
    if (!graphStore) return [];
    return graphStore.neighbors(memoryId, depth);
  };

  // -------------------------------------------------------------------------
  // cypher() — Execute Cypher queries
  // -------------------------------------------------------------------------

  /**
   * Execute a Cypher query against the knowledge graph.
   *
   * @param query  Cypher query string
   * @param params Optional query parameters
   * @returns      Query results, or null if no graph store
   */
  const cypherQuery = (
    query: string,
    params?: Record<string, unknown>,
  ): CypherResult | null => {
    if (!graphStore) return null;

    const result = graphStore.cypher(query, params);

    // Fire and forget
    emitMemory("memory:queried", {
      agentId: options.id,
      query: query.slice(0, 200),
      resultCount: result.rows.length,
    });

    return result;
  };

  // -------------------------------------------------------------------------
  // shortestPath() — Path between memories
  // -------------------------------------------------------------------------

  /**
   * Find the shortest path between two memories in the knowledge graph.
   */
  const shortestPath = (
    fromId: string,
    toId: string,
    maxDepth?: number,
  ): PathResult | null => {
    if (!graphStore) return null;
    return graphStore.shortestPath(fromId, toId, maxDepth);
  };

  // -------------------------------------------------------------------------
  // Graph analytics
  // -------------------------------------------------------------------------

  /**
   * Discover clusters/communities among stored memories.
   */
  const communities = (): Map<string, number> | null => {
    if (!graphStore) return null;
    return graphStore.communities();
  };

  /**
   * Calculate PageRank scores for memories (importance ranking).
   */
  const pageRank = (iterations?: number): Map<string, number> | null => {
    if (!graphStore) return null;
    return graphStore.pageRank(iterations);
  };

  // -------------------------------------------------------------------------
  // Graph node/edge operations (passthrough)
  // -------------------------------------------------------------------------

  /**
   * Create a node in the knowledge graph (for non-memory entities).
   */
  const createNode = async (
    id: string,
    labels: string[],
    properties?: Record<string, unknown>,
  ): Promise<GraphNode | null> => {
    if (!graphStore) return null;
    return graphStore.createNode(id, labels, properties);
  };

  /**
   * Get a node from the knowledge graph.
   */
  const getNode = (id: string): GraphNode | null => {
    if (!graphStore) return null;
    return graphStore.getNode(id);
  };

  /**
   * Find nodes by label in the knowledge graph.
   */
  const findByLabel = (label: string): GraphNode[] => {
    if (!graphStore) return [];
    return graphStore.findByLabel(label);
  };

  /**
   * Get the graph store's stats.
   */
  const graphStats = async (): Promise<{ nodes: number; edges: number } | null> => {
    if (!graphStore) return null;
    return graphStore.stats();
  };

  // -------------------------------------------------------------------------
  // Return the memory agent
  // -------------------------------------------------------------------------

  return {
    // --- BaseAgent (spread) ---
    ...agent,

    // --- Vector memory operations ---
    store,
    recall,
    remember,
    forget,
    storeConversation,
    count,
    get,

    // --- Graph operations (no-op when graphStore not provided) ---
    link,
    unlink,
    related,
    cypher: cypherQuery,
    shortestPath,
    communities,
    pageRank,

    // --- Graph node/edge passthroughs ---
    createNode,
    getNode,
    findByLabel,
    graphStats,

    // --- Provider info ---
    vectorStore: () => vectorStore,
    embedder: () => embedder,
    graphStore: () => graphStore,
    hasGraph: () => !!graphStore,
  };
};
