/**
 * Memory Module Demo
 *
 * Demonstrates the full capabilities of the memory module:
 *   1. Vector-based semantic memory (store, recall, remember)
 *   2. Knowledge graph with Cypher queries
 *   3. Graph traversal and analytics
 *   4. Hybrid search (vector + graph)
 *
 * Run: bun run src/memory-demo.ts
 */

import figlet from "figlet";
import { KnowledgeGraphAgent } from "./memory/examples/knowledge-graph-agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const hr = () => console.log("─".repeat(60));
const section = (title: string) => {
  console.log();
  hr();
  console.log(`  ${title}`);
  hr();
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async () => {
  // Banner
  console.log(figlet.textSync("Memory Agent", { font: "Small" }));
  console.log("  Ruvector-powered semantic memory + knowledge graph\n");

  // =========================================================================
  // 1. Create a KnowledgeGraphAgent (combines vector memory + graph DB)
  // =========================================================================

  section("1. Creating Knowledge Graph Agent");

  const kg = KnowledgeGraphAgent({
    id: "demo-kg",
    name: "Demo Knowledge Graph",
    dimensions: 128,
  });
  await kg.start();
  console.log("✅ Knowledge Graph Agent started");

  // =========================================================================
  // 2. Learn Facts (stored as vector memories + graph nodes)
  // =========================================================================

  section("2. Learning Facts");

  await kg.learnFact(
    "TypeScript",
    ["Language"],
    { paradigm: "typed", year: 2012 },
    "TypeScript is a strongly typed superset of JavaScript developed by Microsoft",
  );
  console.log("  📝 Learned: TypeScript (Language)");

  await kg.learnFact(
    "JavaScript",
    ["Language"],
    { paradigm: "dynamic", year: 1995 },
    "JavaScript is a dynamic scripting language for web development",
  );
  console.log("  📝 Learned: JavaScript (Language)");

  await kg.learnFact(
    "Bun",
    ["Runtime"],
    { version: "1.3", creator: "Jarred Sumner" },
    "Bun is a fast all-in-one JavaScript runtime and toolkit",
  );
  console.log("  📝 Learned: Bun (Runtime)");

  await kg.learnFact(
    "Node.js",
    ["Runtime"],
    { version: "20", creator: "Ryan Dahl" },
    "Node.js is a server-side JavaScript runtime built on V8",
  );
  console.log("  📝 Learned: Node.js (Runtime)");

  await kg.learnFact(
    "Rorschach",
    ["Framework"],
    { type: "agent-system" },
    "Rorschach is an async event-driven agent framework built with Bun and TypeScript",
  );
  console.log("  📝 Learned: Rorschach (Framework)");

  await kg.learnFact(
    "Ruvector",
    ["Library"],
    { type: "vector-database" },
    "Ruvector is a high-performance vector database for Node.js with Rust backend",
  );
  console.log("  📝 Learned: Ruvector (Library)");

  await kg.learnFact(
    "HNSW",
    ["Algorithm"],
    { type: "approximate-nearest-neighbor" },
    "HNSW is a graph-based algorithm for efficient approximate nearest neighbor search",
  );
  console.log("  📝 Learned: HNSW (Algorithm)");

  // =========================================================================
  // 3. Learn Relationships
  // =========================================================================

  section("3. Building Knowledge Graph Relationships");

  kg.learnRelation("TypeScript", "JavaScript", "SUPERSET_OF");
  console.log("  🔗 TypeScript --SUPERSET_OF--> JavaScript");

  kg.learnRelation("Bun", "TypeScript", "SUPPORTS");
  console.log("  🔗 Bun --SUPPORTS--> TypeScript");

  kg.learnRelation("Bun", "JavaScript", "SUPPORTS");
  console.log("  🔗 Bun --SUPPORTS--> JavaScript");

  kg.learnRelation("Node.js", "JavaScript", "SUPPORTS");
  console.log("  🔗 Node.js --SUPPORTS--> JavaScript");

  kg.learnRelation("Rorschach", "Bun", "RUNS_ON");
  console.log("  🔗 Rorschach --RUNS_ON--> Bun");

  kg.learnRelation("Rorschach", "TypeScript", "WRITTEN_IN");
  console.log("  🔗 Rorschach --WRITTEN_IN--> TypeScript");

  kg.learnRelation("Rorschach", "Ruvector", "USES");
  console.log("  🔗 Rorschach --USES--> Ruvector");

  kg.learnRelation("Ruvector", "HNSW", "IMPLEMENTS");
  console.log("  🔗 Ruvector --IMPLEMENTS--> HNSW");

  // =========================================================================
  // 4. Semantic Search (Vector-based)
  // =========================================================================

  section("4. Semantic Search");

  console.log('\n  Query: "fast JavaScript runtime"');
  const searchResults = await kg.search("fast JavaScript runtime", 3);
  for (const r of searchResults) {
    console.log(`    📌 (${r.score.toFixed(3)}) ${r.entry.content}`);
  }

  console.log('\n  Query: "typed programming language"');
  const searchResults2 = await kg.search("typed programming language", 3);
  for (const r of searchResults2) {
    console.log(`    📌 (${r.score.toFixed(3)}) ${r.entry.content}`);
  }

  // =========================================================================
  // 5. Cypher Queries
  // =========================================================================

  section("5. Cypher Queries");

  console.log('\n  Query: MATCH (n)-[r:SUPPORTS]->(m) RETURN n.id, r.type, m.id');
  const cypherResult1 = kg.query(
    `MATCH (n)-[r:SUPPORTS]->(m) RETURN n.id, r.type, m.id`,
  );
  if (cypherResult1) {
    console.log(`    Columns: ${cypherResult1.columns.join(", ")}`);
    for (const row of cypherResult1.rows) {
      console.log(`    → ${row.join(" | ")}`);
    }
  }

  console.log('\n  Query: MATCH (n)-[r:RUNS_ON]->(m) RETURN n.id, m.id');
  const cypherResult2 = kg.query(
    `MATCH (n)-[r:RUNS_ON]->(m) RETURN n.id, m.id`,
  );
  if (cypherResult2) {
    for (const row of cypherResult2.rows) {
      console.log(`    → ${row.join(" --RUNS_ON--> ")}`);
    }
  }

  console.log('\n  Query: MATCH (n:Framework)-[r]->(m) RETURN n.id, r.type, m.id');
  const cypherResult3 = kg.query(
    `MATCH (n:Framework)-[r]->(m) RETURN n.id, r.type, m.id`,
  );
  if (cypherResult3) {
    for (const row of cypherResult3.rows) {
      console.log(`    → ${row.join(" | ")}`);
    }
  }

  // =========================================================================
  // 6. Graph Traversal
  // =========================================================================

  section("6. Graph Traversal");

  console.log("\n  Entities related to Rorschach (depth 1):");
  const related = kg.relatedTo("Rorschach", 1);
  for (const node of await related) {
    console.log(`    🔗 ${node.id} [${node.labels.join(", ")}]`);
  }

  console.log("\n  Entities related to Rorschach (depth 2):");
  const related2 = kg.relatedTo("Rorschach", 2);
  for (const node of await related2) {
    console.log(`    🔗 ${node.id} [${node.labels.join(", ")}]`);
  }

  console.log("\n  Shortest path: HNSW → JavaScript");
  const path = kg.pathBetween("HNSW", "JavaScript");
  if (path) {
    const nodeIds = path.nodes.map((n) => n.id);
    console.log(`    📍 Path (length ${path.length}): ${nodeIds.join(" → ")}`);
    for (const edge of path.edges) {
      console.log(`       ${edge.from} --${edge.type}--> ${edge.to}`);
    }
  } else {
    console.log("    ❌ No path found");
  }

  // =========================================================================
  // 7. Hybrid Search (Vector + Graph)
  // =========================================================================

  section("7. Hybrid Search (Vector + Graph Context)");

  console.log('\n  Query: "agent framework" (with graph context)');
  const hybridResults = await kg.searchWithContext("agent framework", 3, 1);
  for (const r of hybridResults) {
    console.log(`    📌 (${r.score.toFixed(3)}) ${r.entry.content}`);
    if (r.relatedEntities.length > 0) {
      console.log(`       Related: ${r.relatedEntities.map((e) => e.id).join(", ")}`);
    }
  }

  // =========================================================================
  // 8. Graph Analytics
  // =========================================================================

  section("8. Graph Analytics");

  console.log("\n  PageRank (importance ranking):");
  const ranking = kg.importanceRanking();
  for (const { entity, score } of ranking.slice(0, 7)) {
    const bar = "█".repeat(Math.round(score * 100));
    console.log(`    ${entity.padEnd(15)} ${score.toFixed(4)} ${bar}`);
  }

  console.log("\n  Community detection:");
  const communities = kg.discoverClusters();
  if (communities) {
    const grouped = new Map<number, string[]>();
    for (const [entity, community] of communities) {
      if (!grouped.has(community)) grouped.set(community, []);
      grouped.get(community)!.push(entity);
    }
    for (const [community, members] of grouped) {
      console.log(`    Cluster ${community}: ${members.join(", ")}`);
    }
  }

  // =========================================================================
  // 9. Stats
  // =========================================================================

  section("9. Statistics");

  const stats = kg.stats();
  const graphStats = (await stats).graph;
  const memoryCount = await (await stats).memories;

  console.log(`  📊 Memories stored: ${memoryCount}`);
  if (graphStats) {
    console.log(`  📊 Graph nodes:    ${graphStats.nodes}`);
    console.log(`  📊 Graph edges:    ${graphStats.edges}`);
  }

  // =========================================================================
  // Cleanup
  // =========================================================================

  await kg.stop();
  console.log("\n✅ Demo complete!");
};

main().catch(console.error);
