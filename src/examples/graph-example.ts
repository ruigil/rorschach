import { GrafeoDB } from '@grafeo-db/js';

const db = await GrafeoDB.create("kgraph");

// ─── Nodes ───

const nodesResult = await db.execute("MATCH (n) RETURN n");
const nodes = nodesResult.rows() as unknown[];

console.log(`\nNodes (${nodes.length} total)`);
if (nodes.length === 0) {
  console.log("  (none)");
} else {
  for (const row of nodes) {
    console.log(" ", JSON.stringify(row));
  }
}

// ─── Relationships ───

const relsResult = await db.execute("MATCH (a)-[r]->(b) RETURN a, r, b");
const rels = relsResult.rows() as unknown[];

console.log(`\nRelationships (${rels.length} total)`);
if (rels.length === 0) {
  console.log("  (none)");
} else {
  for (const row of rels) {
    console.log(" ", JSON.stringify(row));
  }
}

await db.close();
