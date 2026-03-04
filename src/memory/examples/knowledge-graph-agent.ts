/**
 * KnowledgeGraphAgent — Demonstrates the graph database capabilities
 * with Cypher queries for building and querying knowledge relationships.
 *
 * This example shows how to:
 *   1. Store facts as graph nodes with typed labels
 *   2. Create relationships between entities (edges)
 *   3. Query the knowledge graph with Cypher
 *   4. Traverse the graph (shortest path, neighbors)
 *   5. Analyze the graph (PageRank, communities)
 *   6. Combine vector search + graph traversal for rich context
 *
 * Uses ruvector's CodeGraph with Cypher language support.
 */

import { EventBus } from "../../events/event-bus";
import { MemoryAgent } from "../memory-agent";
import { RuvectorStore, RuvectorEmbedder, RuvectorGraphStore } from "../ruvector-store";
import type { MemoryEvents, CypherResult, GraphNode, PathResult } from "../types";

// ---------------------------------------------------------------------------
// KnowledgeGraphAgent Options
// ---------------------------------------------------------------------------

export type KnowledgeGraphAgentOptions = {
  /** Unique agent identifier */
  id?: string;

  /** Human-readable name */
  name?: string;

  /** Embedding dimensions (default 128) */
  dimensions?: number;

  /** Optional storage path for persistence */
  storagePath?: string;
};

// ---------------------------------------------------------------------------
// KnowledgeGraphAgent Factory
// ---------------------------------------------------------------------------

/**
 * Create a knowledge graph agent that builds and queries a graph of
 * concepts, entities, and their relationships.
 *
 * Combines vector memory (for semantic search) with a graph database
 * (for relationship traversal and Cypher queries).
 *
 * @example
 * ```ts
 * const kg = KnowledgeGraphAgent();
 * await kg.start();
 *
 * // Add entities
 * await kg.learnFact("TypeScript", ["Language"], { paradigm: "typed" });
 * await kg.learnFact("Bun", ["Runtime"], { version: "1.3" });
 * await kg.learnFact("Rorschach", ["Framework"], { type: "agent-system" });
 *
 * // Add relationships
 * kg.learnRelation("Bun", "TypeScript", "SUPPORTS");
 * kg.learnRelation("Rorschach", "Bun", "RUNS_ON");
 * kg.learnRelation("Rorschach", "TypeScript", "WRITTEN_IN");
 *
 * // Cypher queries
 * const result = kg.query(
 *   `MATCH (n:Framework)-[r:RUNS_ON]->(m:Runtime) RETURN n.id, m.id`
 * );
 *
 * // Graph traversal
 * const related = kg.relatedTo("Rorschach", 2);
 * const path = kg.pathBetween("TypeScript", "Bun");
 *
 * // Analytics
 * const rankings = kg.importanceRanking();
 * const clusters = kg.discoverClusters();
 * ```
 */
export const KnowledgeGraphAgent = (options: KnowledgeGraphAgentOptions = {}) => {
  const {
    id = "kg-agent",
    name = "Knowledge Graph Agent",
    dimensions = 128,
    storagePath,
  } = options;

  const bus = new EventBus<MemoryEvents>();

  // Create memory agent with both vector store and graph store
  const memory = MemoryAgent({
    id,
    name,
    bus,
    vectorStore: RuvectorStore({ dimensions }),
    embedder: RuvectorEmbedder({ dimensions }),
    graphStore: RuvectorGraphStore({
      storagePath,
    }),
  });

  // -------------------------------------------------------------------------
  // Fact management
  // -------------------------------------------------------------------------

  /**
   * Learn a fact by storing it as both a vector memory and a graph node.
   *
   * @param entity     Entity name (also used as graph node ID)
   * @param labels     Graph labels (e.g. ["Language"], ["Person", "Developer"])
   * @param properties Optional properties
   * @param description Optional longer description for vector embedding
   * @returns          The memory ID
   */
  const learnFact = async (
    entity: string,
    labels: string[],
    properties?: Record<string, unknown>,
    description?: string,
  ): Promise<string> => {
    // Store in vector memory (for semantic search)
    const content = description ?? `${entity} (${labels.join(", ")})`;
    const memoryId = await memory.store(
      content,
      { entity, labels, ...properties },
      entity, // Use entity name as ID for easy reference
    );

    return memoryId;
  };

  /**
   * Create a typed relationship between two entities.
   *
   * @param from         Source entity
   * @param to           Target entity
   * @param relationship Relationship type (e.g. "SUPPORTS", "DEPENDS_ON", "WRITTEN_IN")
   * @param properties   Optional edge properties (e.g. { since: "2023" })
   */
  const learnRelation = async (
    from: string,
    to: string,
    relationship: string,
    properties?: Record<string, unknown>,
  ) => {
    return memory.link(from, to, relationship, properties);
  };

  // -------------------------------------------------------------------------
  // Cypher queries
  // -------------------------------------------------------------------------

  /**
   * Execute a Cypher query against the knowledge graph.
   *
   * @example
   * ```ts
   * // Find all runtimes that support TypeScript
   * kg.query(`MATCH (n)-[r:SUPPORTS]->(m:Language) WHERE m.id = 'TypeScript' RETURN n.id`);
   *
   * // Find all frameworks and what they run on
   * kg.query(`MATCH (f:Framework)-[r:RUNS_ON]->(rt:Runtime) RETURN f.id, rt.id`);
   *
   * // Find all entities connected to a specific node
   * kg.query(`MATCH (n)-[r]-(m) WHERE n.id = 'Rorschach' RETURN r.type, m.id`);
   * ```
   */
  const query = (
    cypherQuery: string,
    params?: Record<string, unknown>,
  ): CypherResult | null => {
    return memory.cypher(cypherQuery, params);
  };

  // -------------------------------------------------------------------------
  // Graph traversal
  // -------------------------------------------------------------------------

  /**
   * Find entities related to a given entity via graph traversal.
   *
   * @param entity Entity name
   * @param depth  How many hops to traverse (default 1)
   */
  const relatedTo = async (entity: string, depth: number = 1): Promise<GraphNode[]> => {
    return memory.related(entity, depth);
  };

  /**
   * Find the shortest path between two entities.
   */
  const pathBetween = (
    from: string,
    to: string,
    maxDepth?: number,
  ): PathResult | null => {
    return memory.shortestPath(from, to, maxDepth);
  };

  /**
   * Get all outgoing relationships from an entity.
   */
  const outgoingRelations = (entity: string): CypherResult | null => {
    return query(
      `MATCH (n)-[r]->(m) WHERE n.id = '${entity}' RETURN r.type, m.id`,
    );
  };

  /**
   * Get all incoming relationships to an entity.
   */
  const incomingRelations = (entity: string): CypherResult | null => {
    return query(
      `MATCH (n)-[r]->(m) WHERE m.id = '${entity}' RETURN n.id, r.type`,
    );
  };

  // -------------------------------------------------------------------------
  // Semantic + graph hybrid search
  // -------------------------------------------------------------------------

  /**
   * Semantic search across stored facts.
   *
   * @param searchQuery Natural language query
   * @param k           Number of results (default 5)
   */
  const search = async (searchQuery: string, k: number = 5) => {
    return memory.recall(searchQuery, k);
  };

  /**
   * Combined search: semantic similarity + graph context.
   *
   * First finds semantically similar facts, then enriches each result
   * with its graph relationships (neighbors).
   */
  const searchWithContext = async (
    searchQuery: string,
    k: number = 5,
    graphDepth: number = 1,
  ) => {
    const results = await memory.recall(searchQuery, k);

    const enriched = [];
    for (const r of results) {
      const neighbors = await memory.related(r.entry.id, graphDepth);
      enriched.push({
        ...r,
        relatedEntities: neighbors.map((n) => ({
          id: n.id,
          labels: n.labels,
          properties: n.properties,
        })),
      });
    }
    return enriched;
  };

  // -------------------------------------------------------------------------
  // Graph analytics
  // -------------------------------------------------------------------------

  /**
   * Rank entities by importance using PageRank.
   * Returns an array sorted by rank (most important first).
   */
  const importanceRanking = (): Array<{ entity: string; score: number }> => {
    const rankings = memory.pageRank();
    if (!rankings) return [];

    return [...rankings.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([entity, score]) => ({ entity, score }));
  };

  /**
   * Discover clusters/communities among entities.
   * Returns a map of entity → community ID.
   */
  const discoverClusters = (): Map<string, number> | null => {
    return memory.communities();
  };

  /**
   * Get graph statistics.
   */
  const stats = async () => {
    return {
      graph: await memory.graphStats(),
      memories: await memory.count(),
    };
  };

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  const start = async () => {
    await memory.start();
  };

  const stop = async () => {
    await memory.stop();
  };

  // -------------------------------------------------------------------------
  // Return the knowledge graph agent
  // -------------------------------------------------------------------------

  return {
    // Lifecycle
    start,
    stop,

    // Fact management
    learnFact,
    learnRelation,

    // Cypher queries
    query,

    // Graph traversal
    relatedTo,
    pathBetween,
    outgoingRelations,
    incomingRelations,

    // Search
    search,
    searchWithContext,

    // Analytics
    importanceRanking,
    discoverClusters,
    stats,

    // Direct access
    memory: () => memory,
    bus: () => bus,
  };
};
