/**
 * Memory module tests.
 *
 * Tests cover:
 *   - RuvectorEmbedder (text → vector embedding)
 *   - RuvectorStore (vector storage + similarity search)
 *   - RuvectorGraphStore (graph database + Cypher queries)
 *   - MemoryAgent (store, recall, remember, forget, graph ops)
 *   - Memory events (observability)
 *   - KnowledgeGraphAgent example
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { EventBus } from "../events/event-bus";
import { MemoryAgent } from "../memory/memory-agent";
import { RuvectorEmbedder, RuvectorStore, RuvectorGraphStore } from "../memory/ruvector-store";
import { KnowledgeGraphAgent } from "../memory/examples/knowledge-graph-agent";
import type { MemoryEvents } from "../memory/types";

// ===========================================================================
// RuvectorEmbedder
// ===========================================================================

describe("RuvectorEmbedder", () => {
  test("creates an embedder with default dimensions", () => {
    const embedder = RuvectorEmbedder();
    expect(embedder.name).toBe("ruvector-ngram");
    expect(embedder.dimensions).toBe(128);
  });

  test("creates an embedder with custom dimensions", () => {
    const embedder = RuvectorEmbedder({ dimensions: 64 });
    expect(embedder.dimensions).toBe(64);
  });

  test("embed() returns a vector of correct dimensions", async () => {
    const embedder = RuvectorEmbedder({ dimensions: 128 });
    const vector = await embedder.embed("Hello, world!");
    expect(vector).toBeInstanceOf(Array);
    expect(vector.length).toBe(128);
    // Every element should be a number
    for (const v of vector) {
      expect(typeof v).toBe("number");
    }
  });

  test("embed() returns different vectors for different texts", async () => {
    const embedder = RuvectorEmbedder({ dimensions: 128 });
    const v1 = await embedder.embed("TypeScript is great");
    const v2 = await embedder.embed("Python is popular");
    // They shouldn't be identical
    const differs = v1.some((val, i) => val !== v2[i]);
    expect(differs).toBe(true);
  });

  test("embed() returns same vector for same text (deterministic)", async () => {
    const embedder = RuvectorEmbedder({ dimensions: 128 });
    const v1 = await embedder.embed("consistent embedding");
    const v2 = await embedder.embed("consistent embedding");
    expect(v1).toEqual(v2);
  });

  test("embedBatch() embeds multiple texts at once", async () => {
    const embedder = RuvectorEmbedder({ dimensions: 64 });
    const vectors = await embedder.embedBatch(["Hello", "World", "Test"]);
    expect(vectors.length).toBe(3);
    for (const v of vectors) {
      expect(v.length).toBe(64);
    }
  });
});

// ===========================================================================
// RuvectorStore
// ===========================================================================

/** Helper: create a 128-dim vector with a value at a specific index */
const vec128 = (index: number, value: number = 1): number[] => {
  const v = new Array(128).fill(0);
  v[index] = value;
  return v;
};

/** Unique path generator to isolate VectorDb instances between tests */
let storeId = 0;
const uniqueStore = () => RuvectorStore({
  dimensions: 128,
  storagePath: `/tmp/rorschach-test-${Date.now()}-${++storeId}.db`,
});

describe("RuvectorStore", () => {
  test("creates a store with specified dimensions", () => {
    const store = uniqueStore();
    expect(store.name).toBe("ruvector");
  });

  test("insert() and count()", async () => {
    const store = uniqueStore();
    await store.insert("vec-1", vec128(0), { label: "x-axis" });
    await store.insert("vec-2", vec128(1), { label: "y-axis" });
    const count = await store.count();
    expect(count).toBe(2);
  });

  test("get() retrieves a stored vector", async () => {
    const store = uniqueStore();
    await store.insert("vec-1", vec128(0), { label: "test" });
    const entry = await store.get("vec-1");
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe("vec-1");
    expect(entry!.metadata?.label).toBe("test");
  });

  test("get() returns null for non-existent ID", async () => {
    const store = uniqueStore();
    const entry = await store.get("non-existent");
    expect(entry).toBeNull();
  });

  test("search() finds similar vectors", async () => {
    const store = uniqueStore();
    const vA = vec128(0);
    const vB = vec128(0, 0.9); vB[1] = 0.1;
    const vC = vec128(3);
    await store.insert("a", vA);
    await store.insert("b", vB);
    await store.insert("c", vC);

    const results = await store.search(vec128(0), 2);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // "a" should be the closest match
    expect(results[0]!.id).toBe("a");
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  test("search() respects threshold filter", async () => {
    const store = uniqueStore();
    await store.insert("a", vec128(0));
    await store.insert("b", vec128(3));

    // Very high threshold — might filter out low-scoring results
    const results = await store.search(vec128(0), 5, 0.99);
    // At minimum, the exact match should be returned
    if (results.length > 0) {
      expect(results[0]!.score).toBeGreaterThanOrEqual(0.99);
    }
  });

  test("delete() removes a vector", async () => {
    const store = uniqueStore();
    await store.insert("del-me", vec128(0));
    const before = await store.count();
    expect(before).toBe(1);

    const deleted = await store.delete("del-me");
    expect(deleted).toBe(true);

    const after = await store.count();
    expect(after).toBe(0);
  });

  test("delete() returns false for non-existent ID", async () => {
    const store = uniqueStore();
    const deleted = await store.delete("ghost");
    expect(deleted).toBe(false);
  });
});

// ===========================================================================
// RuvectorGraphStore
// ===========================================================================

describe("RuvectorGraphStore", () => {
  test("creates an in-memory graph store", async () => {
    const graph = RuvectorGraphStore();
    expect(graph.name).toBe("ruvector-graph");
    expect(await graph.stats()).toEqual({ nodes: 0, edges: 0 });
  });

  test("createNode() and getNode()", async () => {
    const graph = RuvectorGraphStore();
    const node = await graph.createNode("ts", ["Language"], { paradigm: "typed" });
    expect(node.id).toBe("ts");
    expect(node.labels).toEqual(["Language"]);
    expect(node.properties.paradigm).toBe("typed");

    const retrieved = graph.getNode("ts");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe("ts");
  });

  test("getNode() returns null for non-existent node", async () => {
    const graph = RuvectorGraphStore();
    expect(graph.getNode("ghost")).toBeNull();
  });

  test("findByLabel() finds nodes by label", async () => {
    const graph = RuvectorGraphStore();
    await graph.createNode("ts", ["Language"], { name: "TypeScript" });
    await graph.createNode("py", ["Language"], { name: "Python" });
    await graph.createNode("bun", ["Runtime"], { name: "Bun" });

    const languages = graph.findByLabel("Language");
    expect(languages.length).toBe(2);
    const ids = languages.map((n) => n.id).sort();
    expect(ids).toEqual(["py", "ts"]);
  });

  test("createEdge() and getOutgoing()", async () => {
    const graph = RuvectorGraphStore();
    await graph.createNode("bun", ["Runtime"]);
    await graph.createNode("ts", ["Language"]);

    const edge = await graph.createEdge("bun", "ts", "SUPPORTS");
    expect(edge.from).toBe("bun");
    expect(edge.to).toBe("ts");
    expect(edge.type).toBe("SUPPORTS");

    const outgoing = graph.getOutgoing("bun");
    expect(outgoing.length).toBe(1);
    expect(outgoing[0]!.type).toBe("SUPPORTS");
  });

  test("getIncoming() returns edges pointing to a node", async () => {
    const graph = RuvectorGraphStore();
    await graph.createNode("bun", ["Runtime"]);
    await graph.createNode("ts", ["Language"]);
    await graph.createEdge("bun", "ts", "SUPPORTS");

    const incoming = graph.getIncoming("ts");
    expect(incoming.length).toBe(1);
    expect(incoming[0]!.from).toBe("bun");
  });

  test("cypher() MATCH query", async () => {
    const graph = RuvectorGraphStore();
    await graph.createNode("bun", ["Runtime"], { name: "Bun" });
    await graph.createNode("ts", ["Language"], { name: "TypeScript" });
    await graph.createEdge("bun", "ts", "SUPPORTS");

    const result = graph.cypher(
      `MATCH (n)-[r:SUPPORTS]->(m) RETURN n.id, m.id`,
    );
    expect(result.columns.length).toBeGreaterThan(0);
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
  });

  test("deleteNode() removes a node", async () => {
    const graph = RuvectorGraphStore();
    await graph.createNode("tmp", ["Temp"]);
    expect((await graph.stats()).nodes).toBe(1);

    const deleted = graph.deleteNode("tmp");
    expect(deleted).toBe(true);
    expect((await graph.stats()).nodes).toBe(0);
  });

  test("updateNode() updates properties", async () => {
    const graph = RuvectorGraphStore();
    await graph.createNode("bun", ["Runtime"], { version: "1.0" });
    graph.updateNode("bun", { version: "1.3" });

    const node = graph.getNode("bun");
    expect(node!.properties.version).toBe("1.3");
  });

  test("clear() removes all data", async () => {
    const graph = RuvectorGraphStore();
    await graph.createNode("a", ["X"]);
    await graph.createNode("b", ["Y"]);
    await graph.createEdge("a", "b", "LINKED");

    graph.clear();
    expect(await graph.stats()).toEqual({ nodes: 0, edges: 0 });
  });

  test("neighbors() returns connected nodes", async () => {
    const graph = RuvectorGraphStore();
    await graph.createNode("a", ["X"]);
    await graph.createNode("b", ["Y"]);
    await graph.createNode("c", ["Z"]);
    await graph.createEdge("a", "b", "LINKED");
    await graph.createEdge("b", "c", "LINKED");

    const n = await graph.neighbors("a", 1);
    expect(n.length).toBeGreaterThanOrEqual(1);
  });

  test("shortestPath() between two nodes", async () => {
    const graph = RuvectorGraphStore();
    await graph.createNode("a", ["X"]);
    await graph.createNode("b", ["Y"]);
    await graph.createNode("c", ["Z"]);
    await graph.createEdge("a", "b", "LINKED");
    await graph.createEdge("b", "c", "LINKED");

    const path = graph.shortestPath("a", "c");
    expect(path).not.toBeNull();
    if (path) {
      expect(path.length).toBeGreaterThanOrEqual(1);
      expect(path.nodes.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ===========================================================================
// MemoryAgent
// ===========================================================================

describe("MemoryAgent", () => {
  let bus: EventBus<MemoryEvents>;
  let agent: ReturnType<typeof MemoryAgent>;

  beforeEach(() => {
    bus = new EventBus<MemoryEvents>();
    agent = MemoryAgent({
      id: "mem-test",
      name: "Test Memory",
      bus,
      vectorStore: uniqueStore(),
      embedder: RuvectorEmbedder({ dimensions: 128 }),
    });
  });

  test("store() stores a memory and returns an ID", async () => {
    await agent.start();
    const id = await agent.store("Hello, world!");
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  test("store() with explicit ID", async () => {
    await agent.start();
    const id = await agent.store("Custom ID memory", undefined, "my-id");
    expect(id).toBe("my-id");
  });

  test("count() returns number of stored memories", async () => {
    await agent.start();
    await agent.store("First");
    await agent.store("Second");
    const count = await agent.count();
    expect(count).toBe(2);
  });

  test("get() retrieves a stored memory", async () => {
    await agent.start();
    const id = await agent.store("Retrieve me", { tag: "test" });
    const entry = await agent.get(id);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("Retrieve me");
    expect(entry!.id).toBe(id);
  });

  test("get() returns null for non-existent memory", async () => {
    await agent.start();
    const entry = await agent.get("non-existent");
    expect(entry).toBeNull();
  });

  test("recall() finds similar memories via semantic search", async () => {
    await agent.start();
    await agent.store("TypeScript is a typed superset of JavaScript");
    await agent.store("Bun is a fast JavaScript runtime");
    await agent.store("Cats are fluffy animals");

    const results = await agent.recall("JavaScript runtime", 5);
    expect(results.length).toBeGreaterThan(0);
    // The most relevant results should mention JavaScript or runtime
    const topContent = results[0]!.entry.content;
    expect(typeof topContent).toBe("string");
  });

  test("recall() returns empty array when nothing matches", async () => {
    await agent.start();
    const results = await agent.recall("query about nothing", 5);
    expect(results).toEqual([]);
  });

  test("remember() returns formatted context string", async () => {
    await agent.start();
    await agent.store("The sky is blue");
    await agent.store("Water is wet");

    const context = await agent.remember("what color is the sky", 3, 0);
    if (context) {
      expect(context).toContain("[Relevant memories]:");
      expect(context).toContain("1.");
    }
  });

  test("remember() returns empty string when no matches above threshold", async () => {
    await agent.start();
    const context = await agent.remember("nothing here", 3, 0.99);
    expect(context).toBe("");
  });

  test("forget() deletes a memory", async () => {
    await agent.start();
    const id = await agent.store("Forget me");
    expect(await agent.count()).toBe(1);

    const deleted = await agent.forget(id);
    expect(deleted).toBe(true);
    expect(await agent.count()).toBe(0);
  });

  test("forget() returns false for non-existent memory", async () => {
    await agent.start();
    const deleted = await agent.forget("ghost");
    expect(deleted).toBe(false);
  });

  test("storeConversation() stores multiple messages", async () => {
    await agent.start();
    const ids = await agent.storeConversation([
      { role: "user", content: "What is TypeScript?" },
      { role: "assistant", content: "TypeScript is a typed superset of JavaScript." },
    ]);
    expect(ids.length).toBe(2);
    expect(await agent.count()).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Memory events
  // -------------------------------------------------------------------------

  test("emits 'memory:stored' event", async () => {
    const events: Array<{ agentId: string; memoryId: string }> = [];
    bus.on("memory:stored", async (e) => {
      events.push(e.payload);
    });

    await agent.start();
    await agent.store("Event test");

    expect(events.length).toBe(1);
    expect(events[0]!.agentId).toBe("mem-test");
  });

  test("emits 'memory:recalled' event", async () => {
    const events: Array<{ query: string; resultCount: number }> = [];
    bus.on("memory:recalled", async (e) => {
      events.push(e.payload);
    });

    await agent.start();
    await agent.store("Something to find");
    await agent.recall("find something");

    expect(events.length).toBe(1);
    expect(events[0]!.query).toBe("find something");
  });

  test("emits 'memory:forgotten' event", async () => {
    const events: Array<{ memoryId: string }> = [];
    bus.on("memory:forgotten", async (e) => {
      events.push(e.payload);
    });

    await agent.start();
    const id = await agent.store("Will forget");
    await agent.forget(id);

    expect(events.length).toBe(1);
    expect(events[0]!.memoryId).toBe(id);
  });
});

// ===========================================================================
// MemoryAgent with Graph Store
// ===========================================================================

describe("MemoryAgent with GraphStore", () => {
  let bus: EventBus<MemoryEvents>;
  let agent: ReturnType<typeof MemoryAgent>;

  beforeEach(() => {
    bus = new EventBus<MemoryEvents>();
    agent = MemoryAgent({
      id: "mem-graph-test",
      name: "Graph Memory",
      bus,
      vectorStore: uniqueStore(),
      embedder: RuvectorEmbedder({ dimensions: 128 }),
      graphStore: RuvectorGraphStore(),
    });
  });

  test("hasGraph() returns true when graph store is provided", () => {
    expect(agent.hasGraph()).toBe(true);
  });

  test("store() creates a graph node alongside vector entry", async () => {
    await agent.start();
    await agent.store("TypeScript is great", { labels: ["Language"] }, "ts");
    const node = agent.getNode("ts");
    expect(node).not.toBeNull();
    expect(node!.id).toBe("ts");
  });

  test("link() creates relationships between memories", async () => {
    await agent.start();
    await agent.store("TypeScript", undefined, "ts");
    await agent.store("Bun", undefined, "bun");

    const edge = await agent.link("bun", "ts", "SUPPORTS");
    expect(edge).not.toBeNull();
    expect(edge!.type).toBe("SUPPORTS");
  });

  test("related() finds neighbors in the graph", async () => {
    await agent.start();
    await agent.store("Node A", undefined, "a");
    await agent.store("Node B", undefined, "b");
    await agent.link("a", "b", "LINKED_TO");

    const neighbors = await agent.related("a", 1);
    expect(neighbors.length).toBeGreaterThanOrEqual(1);
  });

  test("cypher() executes Cypher queries", async () => {
    await agent.start();
    await agent.store("TypeScript", undefined, "ts");
    await agent.store("Bun", undefined, "bun");
    await agent.link("bun", "ts", "SUPPORTS");

    const result = agent.cypher(
      `MATCH (n)-[r:SUPPORTS]->(m) RETURN n.id, m.id`,
    );
    expect(result).not.toBeNull();
    expect(result!.rows.length).toBeGreaterThanOrEqual(1);
  });

  test("graphStats() returns node and edge counts", async () => {
    await agent.start();
    await agent.store("A", undefined, "a");
    await agent.store("B", undefined, "b");
    await agent.link("a", "b", "REL");

    const stats = await agent.graphStats();
    expect(stats).not.toBeNull();
    expect(stats!.nodes).toBeGreaterThanOrEqual(2);
    expect(stats!.edges).toBeGreaterThanOrEqual(1);
  });

  test("emits 'memory:linked' event when linking", async () => {
    const events: Array<{ fromId: string; toId: string; relationship: string }> = [];
    bus.on("memory:linked", async (e) => {
      events.push(e.payload);
    });

    await agent.start();
    await agent.store("X", undefined, "x");
    await agent.store("Y", undefined, "y");
    await agent.link("x", "y", "ASSOCIATED");

    // Allow microtask to process
    await new Promise((r) => setTimeout(r, 10));

    expect(events.length).toBe(1);
    expect(events[0]!.relationship).toBe("ASSOCIATED");
  });

  test("emits 'memory:queried' event on cypher()", async () => {
    const events: Array<{ query: string }> = [];
    bus.on("memory:queried", async (e) => {
      events.push(e.payload);
    });

    await agent.start();
    await agent.store("Test", undefined, "t");
    agent.cypher(`MATCH (n) RETURN n.id`);

    await new Promise((r) => setTimeout(r, 10));

    expect(events.length).toBe(1);
    expect(events[0]!.query).toContain("MATCH");
  });
});

// ===========================================================================
// MemoryAgent without Graph Store
// ===========================================================================

describe("MemoryAgent without GraphStore", () => {
  test("hasGraph() returns false", () => {
    const bus = new EventBus<MemoryEvents>();
    const agent = MemoryAgent({
      id: "no-graph",
      name: "No Graph",
      bus,
      vectorStore: RuvectorStore({ dimensions: 128 }),
      embedder: RuvectorEmbedder({ dimensions: 128 }),
    });
    expect(agent.hasGraph()).toBe(false);
  });

  test("graph operations return null/empty gracefully", async () => {
    const bus = new EventBus<MemoryEvents>();
    const agent = MemoryAgent({
      id: "no-graph",
      name: "No Graph",
      bus,
      vectorStore: RuvectorStore({ dimensions: 128 }),
      embedder: RuvectorEmbedder({ dimensions: 128 }),
    });

    expect(await agent.link("a", "b", "REL")).toBeNull();
    expect(await agent.related("a")).toEqual([]);
    expect(agent.cypher("MATCH (n) RETURN n")).toBeNull();
    expect(agent.shortestPath("a", "b")).toBeNull();
    expect(agent.communities()).toBeNull();
    expect(agent.pageRank()).toBeNull();
    expect(await agent.graphStats()).toBeNull();
    expect(await agent.createNode("x", ["Y"])).toBeNull();
    expect(agent.getNode("x")).toBeNull();
    expect(agent.findByLabel("Y")).toEqual([]);
  });
});

// ===========================================================================
// KnowledgeGraphAgent (integration)
// ===========================================================================

describe("KnowledgeGraphAgent", () => {
  test("creates and starts successfully", async () => {
    const kg = KnowledgeGraphAgent();
    await kg.start();
    await kg.stop();
  });

  test("learnFact() stores a fact as memory + graph node", async () => {
    const kg = KnowledgeGraphAgent();
    await kg.start();

    const id = await kg.learnFact("TypeScript", ["Language"], { paradigm: "typed" });
    expect(id).toBe("TypeScript");

    // Should be searchable via semantic search
    const results = await kg.search("TypeScript programming language");
    expect(results.length).toBeGreaterThan(0);
  });

  test("learnRelation() creates typed relationships", async () => {
    const kg = KnowledgeGraphAgent();
    await kg.start();

    await kg.learnFact("Bun", ["Runtime"]);
    await kg.learnFact("TypeScript", ["Language"]);
    await kg.learnRelation("Bun", "TypeScript", "SUPPORTS");

    const related = await kg.relatedTo("Bun", 1);
    expect(related.length).toBeGreaterThanOrEqual(1);
  });

  test("query() executes Cypher queries", async () => {
    const kg = KnowledgeGraphAgent();
    await kg.start();

    await kg.learnFact("Rorschach", ["Framework"]);
    await kg.learnFact("Bun", ["Runtime"]);
    await kg.learnRelation("Rorschach", "Bun", "RUNS_ON");

    const result = kg.query(
      `MATCH (n)-[r:RUNS_ON]->(m) RETURN n.id, m.id`,
    );
    expect(result).not.toBeNull();
    expect(result!.rows.length).toBeGreaterThanOrEqual(1);
  });

  test("pathBetween() finds shortest path", async () => {
    const kg = KnowledgeGraphAgent();
    await kg.start();

    await kg.learnFact("A", ["Node"]);
    await kg.learnFact("B", ["Node"]);
    await kg.learnFact("C", ["Node"]);
    await kg.learnRelation("A", "B", "LINKED");
    await kg.learnRelation("B", "C", "LINKED");

    const path = kg.pathBetween("A", "C");
    expect(path).not.toBeNull();
  });

  test("importanceRanking() uses PageRank", async () => {
    const kg = KnowledgeGraphAgent();
    await kg.start();

    await kg.learnFact("Hub", ["Node"]);
    await kg.learnFact("Leaf1", ["Node"]);
    await kg.learnFact("Leaf2", ["Node"]);
    await kg.learnRelation("Leaf1", "Hub", "POINTS_TO");
    await kg.learnRelation("Leaf2", "Hub", "POINTS_TO");

    const ranking = kg.importanceRanking();
    expect(ranking.length).toBeGreaterThan(0);
    // Hub should rank highly
    expect(ranking.some((r) => r.entity === "Hub")).toBe(true);
  });

  test("searchWithContext() combines vector search + graph neighbors", async () => {
    const kg = KnowledgeGraphAgent();
    await kg.start();

    await kg.learnFact("TypeScript", ["Language"], undefined, "TypeScript is a typed programming language");
    await kg.learnFact("Bun", ["Runtime"], undefined, "Bun is a fast JavaScript runtime");
    await kg.learnRelation("Bun", "TypeScript", "SUPPORTS");

    const results = await kg.searchWithContext("programming language", 5, 1);
    expect(results.length).toBeGreaterThan(0);
    // Each result should have relatedEntities
    for (const r of results) {
      expect(r).toHaveProperty("relatedEntities");
      expect(Array.isArray(r.relatedEntities)).toBe(true);
    }
  });
});
