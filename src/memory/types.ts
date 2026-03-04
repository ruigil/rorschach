/**
 * Core type definitions for the memory module.
 *
 * Provides provider-agnostic interfaces for:
 *   - Vector storage (semantic similarity search)
 *   - Text embedding (text → vector conversion)
 *   - Graph storage (knowledge relationships with Cypher queries)
 *
 * These abstractions allow swapping ruvector for Pinecone, ChromaDB,
 * Neo4j, etc. without changing agent code.
 */

// ---------------------------------------------------------------------------
// Memory Entry
// ---------------------------------------------------------------------------

/** A single memory stored in the vector database */
export type MemoryEntry = {
  /** Unique identifier for this memory */
  readonly id: string;

  /** Original text content */
  readonly content: string;

  /** Embedding vector */
  readonly vector: number[];

  /** Arbitrary metadata (tags, source, timestamps, etc.) */
  readonly metadata?: Record<string, unknown>;

  /** When this memory was stored (Unix-ms) */
  readonly timestamp: number;
};

/** A memory search result with similarity score */
export type MemorySearchResult = {
  /** The matched memory entry */
  readonly entry: MemoryEntry;

  /** Similarity score (0–1, higher is better) */
  readonly score: number;
};

// ---------------------------------------------------------------------------
// Vector Store Provider
// ---------------------------------------------------------------------------

/**
 * Provider-agnostic interface for vector storage and similarity search.
 *
 * Implementations: RuvectorStore, (future: PineconeStore, ChromaStore, etc.)
 */
export type VectorStoreProvider = {
  /** Human-readable provider name */
  readonly name: string;

  /**
   * Insert a vector with metadata.
   *
   * @param id       Unique identifier
   * @param vector   Embedding vector
   * @param metadata Optional metadata
   */
  insert(id: string, vector: number[], metadata?: Record<string, unknown>): Promise<void>;

  /**
   * Search for the k most similar vectors to the query.
   *
   * @param vector    Query vector
   * @param k         Number of results (default 5)
   * @param threshold Minimum similarity score (0–1, default 0)
   * @returns         Ranked search results
   */
  search(vector: number[], k?: number, threshold?: number): Promise<VectorSearchResult[]>;

  /**
   * Retrieve a vector entry by ID.
   */
  get(id: string): Promise<VectorEntry | null>;

  /**
   * Delete a vector by ID.
   *
   * @returns true if deleted, false if not found
   */
  delete(id: string): Promise<boolean>;

  /** Remove all vectors from the store */
  clear(): Promise<void>;

  /** Number of vectors currently stored */
  count(): Promise<number>;
};

/** Raw vector entry from the store (before enrichment with content) */
export type VectorEntry = {
  readonly id: string;
  readonly vector: number[];
  readonly metadata?: Record<string, unknown>;
};

/** Raw vector search result */
export type VectorSearchResult = {
  readonly id: string;
  readonly score: number;
  readonly vector: number[];
  readonly metadata?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Embedder Provider
// ---------------------------------------------------------------------------

/**
 * Provider-agnostic interface for text → vector embedding.
 *
 * Implementations: RuvectorEmbedder (LocalNGram), (future: OpenAI, ONNX, etc.)
 */
export type EmbedderProvider = {
  /** Human-readable provider name */
  readonly name: string;

  /** Embedding vector dimensions */
  readonly dimensions: number;

  /**
   * Embed a single text string.
   *
   * @param text The text to embed
   * @returns    The embedding vector
   */
  embed(text: string): Promise<number[]>;

  /**
   * Embed multiple texts in batch.
   *
   * @param texts Array of texts to embed
   * @returns     Array of embedding vectors
   */
  embedBatch(texts: string[]): Promise<number[][]>;
};

// ---------------------------------------------------------------------------
// Graph Store Provider
// ---------------------------------------------------------------------------

/** A node in the knowledge graph */
export type GraphNode = {
  readonly id: string;
  readonly labels: string[];
  readonly properties: Record<string, unknown>;
};

/** A directed edge in the knowledge graph */
export type GraphEdge = {
  readonly id?: string;
  readonly from: string;
  readonly to: string;
  readonly type: string;
  readonly properties?: Record<string, unknown>;
};

/** Result of a Cypher query */
export type CypherResult = {
  readonly columns: string[];
  readonly rows: unknown[][];
};

/** A path through the graph */
export type PathResult = {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  readonly length: number;
};

/**
 * Provider-agnostic interface for graph storage and traversal.
 *
 * Supports Cypher queries, path finding, and graph analytics.
 *
 * Implementations: RuvectorGraphStore, (future: Neo4jStore, etc.)
 */
export type GraphStoreProvider = {
  /** Human-readable provider name */
  readonly name: string;

  // -- Node operations -------------------------------------------------------

  /** Create a node with labels and properties */
  createNode(id: string, labels: string[], properties?: Record<string, unknown>): Promise<GraphNode>;

  /** Get a node by ID */
  getNode(id: string): GraphNode | null;

  /** Update node properties (re-creates the node internally) */
  updateNode(id: string, properties: Record<string, unknown>): boolean;

  /** Delete a node by ID */
  deleteNode(id: string): boolean;

  /** Find all nodes with a given label */
  findByLabel(label: string): GraphNode[];

  // -- Edge operations -------------------------------------------------------

  /** Create a typed edge between two nodes */
  createEdge(from: string, to: string, type: string, properties?: Record<string, unknown>): Promise<GraphEdge>;

  /** Get all outgoing edges from a node, optionally filtered by type */
  getOutgoing(nodeId: string, type?: string): GraphEdge[];

  /** Get all incoming edges to a node, optionally filtered by type */
  getIncoming(nodeId: string, type?: string): GraphEdge[];

  // -- Cypher queries --------------------------------------------------------

  /**
   * Execute a Cypher query against the graph.
   *
   * @param query  Cypher query string
   * @param params Optional query parameters
   * @returns      Query results as columns + rows
   */
  cypher(query: string, params?: Record<string, unknown>): CypherResult;

  // -- Graph traversal -------------------------------------------------------

  /** Find the shortest path between two nodes */
  shortestPath(from: string, to: string, maxDepth?: number): PathResult | null;

  /** Get neighbors of a node up to a given depth */
  neighbors(nodeId: string, depth?: number): Promise<GraphNode[]>;

  // -- Graph analytics -------------------------------------------------------

  /** Calculate PageRank scores for all nodes */
  pageRank(iterations?: number): Map<string, number>;

  /** Detect communities using the Louvain algorithm */
  communities(): Map<string, number>;

  // -- Lifecycle -------------------------------------------------------------

  /** Persist graph to storage */
  save(): void;

  /** Remove all nodes and edges */
  clear(): void;

  /** Get graph statistics */
  stats(): Promise<{ nodes: number; edges: number }>;
};

// ---------------------------------------------------------------------------
// Memory Events (emitted on the bus for observability)
// ---------------------------------------------------------------------------

export type MemoryEvents = {
  /** Fired when a memory is stored */
  "memory:stored": {
    agentId: string;
    memoryId: string;
    content: string;
  };

  /** Fired when memories are recalled via semantic search */
  "memory:recalled": {
    agentId: string;
    query: string;
    resultCount: number;
    topScore: number;
  };

  /** Fired when a memory is deleted */
  "memory:forgotten": {
    agentId: string;
    memoryId: string;
  };

  /** Fired when a graph relationship is created */
  "memory:linked": {
    agentId: string;
    fromId: string;
    toId: string;
    relationship: string;
  };

  /** Fired when a Cypher query is executed */
  "memory:queried": {
    agentId: string;
    query: string;
    resultCount: number;
  };

  /** Fired when a memory operation fails */
  "memory:error": {
    agentId: string;
    operation: string;
    error: string;
  };
};
