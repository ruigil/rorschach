// ─── Zettelkasten note schema ─────────────────────────────────────────────────

const noteSystemHeader = (): string =>
  `### Zettelkasten Note System\n\n` +
  `Notes are atomic units of knowledge capturing one self-contained concept or fact. ` +
  `Each note has a title (name), a synopsis (for search), tags, and body content.\n\n` +
  `**IMPORTANT**: Metadata (id, links, timestamps) is managed by the system. ` +
  `When creating or updating notes, provide ONLY the body content in the 'content' field. ` +
  `Do NOT write markdown frontmatter or headers like 'id:' or 'links:' into the content.\n\n`

const linkTypeOntology = (): string =>
  `### Link type ontology\n` +
  `| type | meaning | follow when query is about… |\n` +
  `|---|---|---|\n` +
  `| causes / caused_by | causal relationship | cause-and-effect, why something happened |\n` +
  `| depends_on / requires | dependency | prerequisites, what something needs to work |\n` +
  `| contains / part_of | composition | what something is made of or belongs to |\n` +
  `| supports / contradicts | evidential | evidence, arguments for or against |\n` +
  `| precedes / follows | temporal | sequence, timeline, what came before/after |\n\n`

const toolDescs = {
  search:
    `**zettel_search** { text, tags[], after? (ISO), before? (ISO) }\n` +
    `  Semantic search via vector embeddings and re-ranking.\n` +
    `  - text: a comma-separated list of query topics (e.g., "coding preferences, language choice").\n` +
    `  - tags: required lowercase tags to enrich the query or filter results.\n` +
    `  - Returns array of { id, name, synopsis, tags, links, content, score }.\n` +
    `  - **links**: Array of { name, type } representing outgoing connections.\n` +
    `  - **score**: 0-1 (semantic similarity). Higher is better.\n\n`,

  create:
    `**zettel_create** { name, synopsis, content, tags[], eventTime? }\n` +
    `  Create a new atomic note. name: 2-5 words, Title Case. synopsis: comma-separated list of query topics.\n\n`,

  update:
    `**zettel_update** { id, content?, name?, synopsis?, tags?, eventTime? }\n` +
    `  Update an existing note. Only pass fields that should change. synopsis: comma-separated list of query topics.\n\n`,

  link:
    `**zettel_link** { fromId, toId, linkType }\n` +
    `  Create a typed directional link between two notes. Both notes must already exist.\n` +
    `  Use note IDs returned by zettel_unlinked_notes, zettel_search, or zettel_create.\n` +
    `  linkType: Use one of the types from the ontology below.\n\n`,

  links:
    `**zettel_links** { id?, name? }\n` +
    `  Return notes linked from a given note, with full content and linkType for each result.\n\n`,

  unlinked:
    `**zettel_unlinked_notes**\n` +
    `  Get notes that are poorly integrated into the knowledge graph. Returns notes that:\n` +
    `  - Are orphans (no incoming and no outgoing links).\n` +
    `  - Have no outgoing links.\n` +
    `  - Have only one outgoing link.\n` +
    `  Use this to find notes that need better integration.\n\n`,
}

const writingRules = (): string =>
  `### Note writing rules\n` +
  `- One note per concept. Keep notes atomic and self-contained.\n` +
  `- **synopsis**: A comma-separated list of query topics — how someone would find this note. ` +
  `Do NOT write a factual sentence here. (e.g., "typescript preference, programming language choice")\n` +
  `- **Tags**: lowercase, single-word or hyphenated: ["typescript", "preference"].\n` +
  `- Do not duplicate facts — update the canonical note instead.\n\n`

export const zettelStoreSection = (userId: string): string =>
  noteSystemHeader() +
  `### Available tools\n\n` +
  toolDescs.search +
  toolDescs.create +
  toolDescs.update +
  `### A-Mem workflow\n` +
  `1. zettel_search to check if a note already covers the topic.\n` +
  `2. zettel_update (merge) if it exists, or zettel_create if it doesn't.\n\n` +
  writingRules()

export const zettelRecallSection = (userId: string): string =>
  noteSystemHeader() +
  `### Available tools\n\n` +
  toolDescs.search +
  toolDescs.links +
  linkTypeOntology() +
  `### Retrieval Strategy\n` +
  `1. zettel_search with relevant query topics and tags.\n` +
  `2. Inspect 'links' in results. Follow them using zettel_links if the linkType matches the query intent.\n` +
  `3. Synthesize a concise answer from the gathered note content.\n`

export const zettelConsolidationSection = (userId: string): string =>
  noteSystemHeader() +
  `### Available tools\n\n` +
  toolDescs.search +
  toolDescs.unlinked +
  toolDescs.link +
  linkTypeOntology() +
  `### Consolidation Workflow\n` +
  `1. **Obtain unlinked notes**: Call zettel_unlinked_notes to find notes needing integration.\n` +
  `2. **Analyze context**: Identify key concepts and facts from the conversation turns.\n` +
  `3. **Search & Connect**: For each unlinked note and turn concept, use zettel_search to find related notes.\n` +
  `4. **Create Relationships**: Use zettel_link to connect notes to the broader knowledge web.\n\n` +
  `### Link Priority\n` +
  `When creating links, prioritize notes in this order:\n` +
  `1. **Orphans**: Notes with NO incoming and NO outgoing links.\n` +
  `2. **No outgoing**: Notes with incoming links but no outgoing links.\n` +
  `3. **Single outgoing**: Notes with exactly one outgoing link.\n\n` +
  `(Consolidation focuses on discovering links across different turns/topics to ensure a dense, reachable graph).\n`
