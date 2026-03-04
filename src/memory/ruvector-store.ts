/**
 * Ruvector adapters — Wraps ruvector's VectorDb and EmbeddingService
 * into the provider-agnostic interfaces defined in types.ts.
 *
 * Four factory functions:
 *   - RuvectorStore()       — VectorStoreProvider backed by ruvector's VectorDb
 *   - RuvectorEmbedder()    — EmbedderProvider backed by ruvector's EmbeddingService
 *   - RuvectorGraphStore()  — GraphStoreProvider backed by ruvector's CodeGraph (native)
 *   - InMemoryGraphStore()  — GraphStoreProvider backed by pure-JS in-memory graph
 */

import { VectorDb, EmbeddingService, LocalNGramProvider } from "ruvector";
import { GraphDatabase } from "@ruvector/graph-node"

import type {
  VectorStoreProvider,
  VectorSearchResult,
  VectorEntry,
  EmbedderProvider,
  GraphStoreProvider,
  GraphNode,
  GraphEdge,
  CypherResult,
  PathResult,
} from "./types";

// ---------------------------------------------------------------------------
// RuvectorStore — VectorStoreProvider
// ---------------------------------------------------------------------------

export type RuvectorStoreOptions = {
  /** Vector dimensions (must match your embedder) */
  dimensions: number;

  /** Optional path for on-disk persistence */
  storagePath?: string;

  /** Distance metric (default "cosine") */
  metric?: "cosine" | "euclidean" | "dot";
};

/**
 * Create a VectorStoreProvider backed by ruvector's VectorDb.
 *
 * Uses HNSW indexing for sub-millisecond similarity search.
 *
 * @example
 * ```ts
 * const store = RuvectorStore({ dimensions: 128 });
 * await store.insert("id-1", [0.1, 0.2, ...], { tag: "example" });
 * const results = await store.search([0.1, 0.2, ...], 5);
 * ```
 */
export const RuvectorStore = (options: RuvectorStoreOptions): VectorStoreProvider => {
  const db = new VectorDb({
    dimensions: options.dimensions,
    ...(options.storagePath ? { storagePath: options.storagePath } : {}),
  });
  

  const insert = async (
    id: string,
    vector: number[],
    metadata?: Record<string, unknown>,
  ): Promise<void> => {
    await db.insert({ id, vector, metadata });
  };

  const search = async (
    vector: number[],
    k: number = 5,
    threshold: number = 0,
  ): Promise<VectorSearchResult[]> => {
    const results = await db.search({ vector, k });
    return results
      .filter((r: { score: number }) => r.score >= threshold)
      .map((r: { id: string; score: number; vector?: Float32Array; metadata?: Record<string, unknown> }) => ({
        id: r.id,
        score: r.score,
        vector: r.vector ? Array.from(r.vector) : [],
        metadata: r.metadata,
      }));
  };

  const get = async (id: string): Promise<VectorEntry | null> => {
    const entry = await db.get(id);
    if (!entry) return null;
    return {
      id: entry.id ?? id,
      vector: entry.vector ? Array.from(entry.vector) : [],
      metadata: entry.metadata,
    };
  };

  const del = async (id: string): Promise<boolean> => {
    return db.delete(id);
  };

  const clear = async (): Promise<void> => {
    // VectorDb doesn't have a clear method, so we recreate
    // For now, we'll track IDs and delete them
    // Actually, based on the wrapper API, there isn't a bulk clear.
    // We'll implement this by creating a fresh instance internally.
    // Since the wrapper class manages an internal db, we'll need a workaround.
    // For simplicity, we note this as a limitation.
    throw new Error("RuvectorStore.clear() is not yet supported — recreate the store instead.");
  };

  const count = async (): Promise<number> => {
    return db.len();
  };

  return {
    name: "ruvector",
    insert,
    search,
    get,
    delete: del,
    clear,
    count,
  };
};

// ---------------------------------------------------------------------------
// RuvectorEmbedder — EmbedderProvider
// ---------------------------------------------------------------------------

export type RuvectorEmbedderOptions = {
  /** Embedding dimensions (default 128) */
  dimensions?: number;

  /** N-gram size for LocalNGramProvider (default 3) */
  ngramSize?: number;
};

/**
 * Create an EmbedderProvider backed by ruvector's EmbeddingService.
 *
 * Uses LocalNGramProvider by default — zero external dependencies, works offline.
 * For higher-quality embeddings, swap in an ONNX or API-based provider.
 *
 * @example
 * ```ts
 * const embedder = RuvectorEmbedder({ dimensions: 128 });
 * const vector = await embedder.embed("Hello world");
 * const vectors = await embedder.embedBatch(["Hello", "World"]);
 * ```
 */
export const RuvectorEmbedder = (options: RuvectorEmbedderOptions = {}): EmbedderProvider => {
  const dims = options.dimensions ?? 128;
  const ngramSize = options.ngramSize ?? 3;

  const service = new EmbeddingService();
  const provider = new LocalNGramProvider(dims, ngramSize);
  service.registerProvider(provider);

  const embed = async (text: string): Promise<number[]> => {
    return service.embedOne(text, "local-ngram");
  };

  const embedBatch = async (texts: string[]): Promise<number[][]> => {
    return service.embed(texts, "local-ngram");
  };

  return {
    name: "ruvector-ngram",
    dimensions: dims,
    embed,
    embedBatch,
  };
};

// ---------------------------------------------------------------------------
// RuvectorGraphStore — Native GraphDatabase from @ruvector/graph-node v2
// ---------------------------------------------------------------------------

export type RuvectorGraphStoreOptions = {
  /** Storage path for persistence (omit for in-memory) */
  storagePath?: string;

  /** Embedding dimensions for graph nodes/edges (default 3) */
  dimensions?: number;
};

/** Convert Record<string, unknown> → Record<string, string> for native API */
const toStringProps = (
  props?: Record<string, unknown>,
): Record<string, string> => {
  if (!props) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    result[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return result;
};

/** Convert Record<string, string> → Record<string, unknown> (parse JSON values) */
const fromStringProps = (
  props?: Record<string, string>,
): Record<string, unknown> => {
  if (!props) return {};
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    try {
      result[k] = JSON.parse(v);
    } catch {
      result[k] = v;
    }
  }
  return result;
};

/**
 * Create a GraphStoreProvider backed by @ruvector/graph-node's native
 * Rust GraphDatabase. Uses NAPI-RS bindings for high-performance graph
 * operations with Cypher query support.
 *
 * Nodes and edges require embeddings (Float32Array). A default zero-vector
 * is provided automatically for structural-only usage.
 *
 * @example
 * ```ts
 * const graph = RuvectorGraphStore();
 *
 * await graph.createNode("ts", ["Language"], { name: "TypeScript" });
 * await graph.createNode("bun", ["Runtime"], { name: "Bun" });
 * await graph.createEdge("bun", "ts", "SUPPORTS");
 *
 * const result = graph.cypher(
 *   `MATCH (n)-[r:SUPPORTS]->(m) RETURN n.id, m.id`
 * );
 * ```
 */
export const RuvectorGraphStore = (
  options: RuvectorGraphStoreOptions = {},
): GraphStoreProvider => {
  const dims = options.dimensions ?? 3;
  const defaultEmbedding = new Float32Array(dims);

  const db = new GraphDatabase({
    storagePath: options.storagePath,
    dimensions: dims,
  });

  // Local mirror for sync read operations (getNode, findByLabel, etc.)
  // Native v2 only exposes async writes + Cypher reads — local mirror
  // enables fast sync lookups without Cypher overhead.
  const localNodes = new Map<string, { id: string; labels: string[]; properties: Record<string, unknown> }>();
  const localEdges: Array<{ id: string; from: string; to: string; type: string; properties: Record<string, unknown> }> = [];

  // -- Node operations -------------------------------------------------------

  const createNode = async (
    id: string,
    labels: string[],
    properties?: Record<string, unknown>,
  ): Promise<GraphNode> => {
    const props = properties ?? {};

    // Write to native GraphDatabase (async)
    await db.createNode({
      id,
      labels,
      properties: toStringProps(props),
      embedding: defaultEmbedding,
    });

    // Mirror locally for sync reads
    const node = { id, labels: [...labels], properties: { ...props } };
    localNodes.set(id, node);

    return node;
  };

  const getNode = (id: string): GraphNode | null => {
    const node = localNodes.get(id);
    return node ? { ...node, labels: [...node.labels], properties: { ...node.properties } } : null;
  };

  const updateNode = (id: string, properties: Record<string, unknown>): boolean => {
    const node = localNodes.get(id);
    if (!node) return false;
    node.properties = { ...node.properties, ...properties };
    return true;
  };

  const deleteNode = (id: string): boolean => {
    if (!localNodes.has(id)) return false;
    localNodes.delete(id);
    // Remove edges referencing this node
    for (let i = localEdges.length - 1; i >= 0; i--) {
      if (localEdges[i]!.from === id || localEdges[i]!.to === id) {
        localEdges.splice(i, 1);
      }
    }
    return true;
  };

  const findByLabel = (label: string): GraphNode[] => {
    const result: GraphNode[] = [];
    for (const node of localNodes.values()) {
      if (node.labels.includes(label)) {
        result.push({ ...node, labels: [...node.labels], properties: { ...node.properties } });
      }
    }
    return result;
  };

  // -- Edge operations -------------------------------------------------------

  const createEdge = async (
    from: string,
    to: string,
    type: string,
    properties?: Record<string, unknown>,
  ): Promise<GraphEdge> => {
    const props = properties ?? {};

    // Write to native GraphDatabase (async)
    const edgeId = await db.createEdge({
      from,
      to,
      description: type,
      embedding: defaultEmbedding,
      metadata: toStringProps(props),
    });

    // Mirror locally
    const edge = { id: edgeId, from, to, type, properties: { ...props } };
    localEdges.push(edge);

    return edge;
  };

  const getOutgoing = (nodeId: string, type?: string): GraphEdge[] => {
    return localEdges.filter(
      (e) => e.from === nodeId && (!type || e.type === type),
    );
  };

  const getIncoming = (nodeId: string, type?: string): GraphEdge[] => {
    return localEdges.filter(
      (e) => e.to === nodeId && (!type || e.type === type),
    );
  };

  // -- Cypher queries (native querySync) -------------------------------------

  const cypher = (
    query: string,
    _params?: Record<string, unknown>,
  ): CypherResult => {
    const result = db.querySync(query);

    // Convert JsQueryResult → CypherResult
    // Native returns {nodes: JsNodeResult[], edges: JsEdgeResult[]}
    // We need to transform to {columns, rows} format
    const columns: string[] = [];
    const rows: unknown[][] = [];

    if (result.nodes.length > 0 && result.edges.length === 0) {
      // Node-only query
      columns.push("n.id", "n.labels");
      for (const n of result.nodes) {
        rows.push([n.id, n.labels.join(",")]);
      }
    } else if (result.edges.length > 0) {
      // Edge query
      columns.push("from", "type", "to");
      for (const e of result.edges) {
        rows.push([e.from, e.edgeType, e.to]);
      }
    }

    // If native returned empty, fall back to local mirror query
    if (rows.length === 0) {
      return cypherLocal(query);
    }

    return { columns, rows };
  };

  /** Fallback: simplified Cypher parser against local mirror */
  const cypherLocal = (query: string): CypherResult => {
    const returnMatch = query.match(/RETURN\s+(.+)$/i);
    if (!returnMatch) return { columns: [], rows: [] };
    const returnCols = returnMatch[1]!.split(",").map((c) => c.trim());

    const whereMatch = query.match(/WHERE\s+(.+?)\s+RETURN/i);
    let whereField: string | undefined;
    let whereValue: string | undefined;
    if (whereMatch) {
      const wm = whereMatch[1]!.match(/([\w.]+)\s*=\s*'([^']+)'/);
      if (wm) {
        whereField = wm[1];
        whereValue = wm[2];
      }
    }

    const edgePattern = query.match(
      /MATCH\s*\((\w+)(?::(\w+))?\)\s*-\s*\[(\w+)(?::(\w+))?\]\s*->\s*\((\w+)(?::(\w+))?\)/i,
    );

    if (edgePattern) {
      const [, nAlias, nLabel, rAlias, rType, mAlias, mLabel] = edgePattern;
      const rows: unknown[][] = [];

      for (const edge of localEdges) {
        if (rType && edge.type !== rType) continue;
        const fromNode = localNodes.get(edge.from);
        const toNode = localNodes.get(edge.to);
        if (!fromNode || !toNode) continue;
        if (nLabel && !fromNode.labels.includes(nLabel)) continue;
        if (mLabel && !toNode.labels.includes(mLabel)) continue;

        if (whereField && whereValue) {
          const matchesWhere = resolveField(whereField, {
            [nAlias!]: fromNode, [rAlias!]: edge, [mAlias!]: toNode,
          }) === whereValue;
          if (!matchesWhere) continue;
        }

        rows.push(returnCols.map((col) =>
          resolveField(col, {
            [nAlias!]: fromNode, [rAlias!]: edge, [mAlias!]: toNode,
          }),
        ));
      }
      return { columns: returnCols, rows };
    }

    const nodePattern = query.match(/MATCH\s*\((\w+)(?::(\w+))?\)/i);
    if (nodePattern) {
      const [, nAlias, nLabel] = nodePattern;
      const rows: unknown[][] = [];

      for (const node of localNodes.values()) {
        if (nLabel && !node.labels.includes(nLabel)) continue;
        if (whereField && whereValue) {
          const matchesWhere = resolveField(whereField, { [nAlias!]: node }) === whereValue;
          if (!matchesWhere) continue;
        }
        rows.push(returnCols.map((col) => resolveField(col, { [nAlias!]: node })));
      }
      return { columns: returnCols, rows };
    }

    return { columns: returnCols, rows: [] };
  };

  const resolveField = (
    field: string,
    bindings: Record<string, Record<string, unknown>>,
  ): unknown => {
    const parts = field.split(".");
    if (parts.length !== 2) return field;
    const [alias, prop] = parts as [string, string];
    const obj = bindings[alias];
    if (!obj) return undefined;
    return obj[prop] ?? (obj.properties as Record<string, unknown> | undefined)?.[prop];
  };

  // -- Graph traversal -------------------------------------------------------

  const shortestPath = (
    from: string,
    to: string,
    maxDepth: number = 10,
  ): PathResult | null => {
    if (!localNodes.has(from) || !localNodes.has(to)) return null;
    if (from === to) return { nodes: [getNode(from)!], edges: [], length: 0 };

    // BFS using local mirror
    const visited = new Set<string>();
    const queue: Array<{ nodeId: string; path: string[]; pathEdges: typeof localEdges }> = [
      { nodeId: from, path: [from], pathEdges: [] },
    ];
    visited.add(from);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.path.length - 1 >= maxDepth) continue;

      for (const edge of localEdges) {
        let nextId: string | null = null;
        if (edge.from === current.nodeId && !visited.has(edge.to)) {
          nextId = edge.to;
        } else if (edge.to === current.nodeId && !visited.has(edge.from)) {
          nextId = edge.from;
        }

        if (nextId) {
          const newPath = [...current.path, nextId];
          const newEdges = [...current.pathEdges, edge];

          if (nextId === to) {
            return {
              nodes: newPath.map((nid) => getNode(nid)!).filter(Boolean),
              edges: newEdges,
              length: newEdges.length,
            };
          }

          visited.add(nextId);
          queue.push({ nodeId: nextId, path: newPath, pathEdges: newEdges });
        }
      }
    }

    return null;
  };

  const neighborsOf = async (nodeId: string, depth: number = 1): Promise<GraphNode[]> => {
    // Use native kHopNeighbors for traversal
    try {
      const neighborIds = await db.kHopNeighbors(nodeId, depth);
      return neighborIds
        .map((nid: string) => getNode(nid))
        .filter((n): n is GraphNode => n !== null);
    } catch {
      // Fallback to local mirror
      const visited = new Set<string>();
      visited.add(nodeId);
      let frontier = [nodeId];

      for (let d = 0; d < depth; d++) {
        const nextFrontier: string[] = [];
        for (const nid of frontier) {
          for (const edge of localEdges) {
            if (edge.from === nid && !visited.has(edge.to)) {
              visited.add(edge.to);
              nextFrontier.push(edge.to);
            }
            if (edge.to === nid && !visited.has(edge.from)) {
              visited.add(edge.from);
              nextFrontier.push(edge.from);
            }
          }
        }
        frontier = nextFrontier;
      }

      visited.delete(nodeId);
      return [...visited].map((nid) => getNode(nid)!).filter(Boolean);
    }
  };

  // -- Graph analytics (JS implementations) ----------------------------------

  const pageRank = (iterations: number = 20): Map<string, number> => {
    const d = 0.85;
    const n = localNodes.size;
    if (n === 0) return new Map();

    const scores = new Map<string, number>();
    for (const id of localNodes.keys()) {
      scores.set(id, 1 / n);
    }

    for (let i = 0; i < iterations; i++) {
      const newScores = new Map<string, number>();
      for (const id of localNodes.keys()) {
        newScores.set(id, (1 - d) / n);
      }
      for (const edge of localEdges) {
        const outDegree = localEdges.filter((e) => e.from === edge.from).length;
        if (outDegree > 0) {
          const contribution = (scores.get(edge.from) ?? 0) / outDegree;
          newScores.set(edge.to, (newScores.get(edge.to) ?? 0) + d * contribution);
        }
      }
      for (const [id, score] of newScores) {
        scores.set(id, score);
      }
    }

    return scores;
  };

  const communities = (): Map<string, number> => {
    const communityMap = new Map<string, number>();
    const visited = new Set<string>();
    let communityId = 0;

    for (const nodeId of localNodes.keys()) {
      if (visited.has(nodeId)) continue;
      const queue = [nodeId];
      visited.add(nodeId);
      while (queue.length > 0) {
        const current = queue.shift()!;
        communityMap.set(current, communityId);
        for (const edge of localEdges) {
          if (edge.from === current && !visited.has(edge.to)) {
            visited.add(edge.to);
            queue.push(edge.to);
          }
          if (edge.to === current && !visited.has(edge.from)) {
            visited.add(edge.from);
            queue.push(edge.from);
          }
        }
      }
      communityId++;
    }

    return communityMap;
  };

  // -- Lifecycle -------------------------------------------------------------

  const save = (): void => {
    // Native DB persists automatically if storagePath was set
  };

  const clear = (): void => {
    localNodes.clear();
    localEdges.length = 0;
  };

  const graphStats = async (): Promise<{ nodes: number; edges: number }> => {
    // Use local mirror as source of truth (native DB doesn't support delete/clear)
    return { nodes: localNodes.size, edges: localEdges.length };
  };

  return {
    name: "ruvector-graph",
    createNode,
    getNode,
    updateNode,
    deleteNode,
    findByLabel,
    createEdge,
    getOutgoing,
    getIncoming,
    cypher,
    shortestPath,
    neighbors: neighborsOf,
    pageRank,
    communities,
    save,
    clear,
    stats: graphStats,
  };
};
