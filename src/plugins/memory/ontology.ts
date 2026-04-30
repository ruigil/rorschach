// ─── Zettelkasten note schema ─────────────────────────────────────────────────
//
// zettelStoreSection  — full tool list + A-Mem write workflow (store, consolidation)
// zettelRecallSection — read-only tools only (recall)

const noteFormatBlock = (): string =>
  `### Zettelkasten Note System\n\n` +

  `### Note format\n` +
  `\`\`\`\n` +
  `---\n` +
  `id: {uuid}\n` +
  `name: Short Title\n` +
  `synopsis: One sentence summary of this note's content.\n` +
  `tags: [tag1, tag2]\n` +
  `createdAt: ISO timestamp\n` +
  `updatedAt: ISO timestamp\n` +
  `links: [Linked Note Title]\n` +
  `---\n\n` +
  `Content here.\n` +
  `\`\`\`\n\n`

export const zettelStoreSection = (userId: string): string =>
  noteFormatBlock() +

  `### Available tools\n\n` +

  `**zettel_search** { text, tags[]?, userId }\n` +
  `  Semantic search via vector embeddings with graph expansion and re-ranking.\n` +
  `  text must be a one-sentence synopsis — this aligns with how embeddings are stored.\n` +
  `  Optional tags enrich the query and serve as fallback filter if no results found.\n` +
  `  Returns array of { id, name, synopsis, tags, links, content, score }.\n\n` +

  `**zettel_create** { name, synopsis, content, tags[], userId }\n` +
  `  Create a new atomic note. name: 2-5 words, Title Case. synopsis: one sentence.\n\n` +

  `**zettel_update** { id, content?, name?, synopsis?, tags?, userId }\n` +
  `  Update an existing note. Only pass fields that should change. Re-embeds with fresh synopsis.\n\n` +

  `**zettel_link** { sourceId?, sourceName?, targetId?, targetName?, userId }\n` +
  `  Create a directional link between two notes. Updates metadata and the knowledge graph.\n` +
  `  Both notes must already exist. Call this only after all notes have been created/updated.\n\n` +

  `### A-Mem workflow (one topic at a time)\n` +
  `1. zettel_search { text: "<one-sentence synopsis of the topic>", userId } → candidate notes with full content\n` +
  `2. If a candidate already covers this topic → zettel_update (merge new information)\n` +
  `3. If no relevant note exists → zettel_create (new atomic note)\n` +
  `   Repeat steps 1–3 for all topics. Create ALL notes before creating any links.\n` +
  `4. zettel_link { sourceName, targetName, userId } for each relationship between notes.\n` +
  `   Only call zettel_link after both notes are confirmed to exist.\n\n` +

  `### Note writing rules\n` +
  `- One note per concept or fact cluster. Keep notes atomic and self-contained.\n` +
  `- synopsis must accurately summarize the note content — it drives semantic search.\n` +
  `- Tags are lowercase, single-word or hyphenated: ["typescript", "work", "preference"].\n` +
  `- Do not duplicate facts across notes — update the canonical note instead.\n` +
  `- **Strict Link Validation**: NEVER speculate on note titles. Only create links via zettel_link using:\n` +
  `  1. The exact 'name' returned by zettel_search.\n` +
  `  2. The exact 'name' of a note you just created with zettel_create in this same turn.\n` +
  `- If you want to link to a concept but don't know if a note exists, use zettel_search to discover it first.`

export const zettelRecallSection = (userId: string): string =>
  noteFormatBlock() +

  `### Available tools\n\n` +

  `**zettel_search** { text, tags[]?, userId }\n` +
  `  Semantic search via vector embeddings with graph expansion and re-ranking.\n` +
  `  text must be a one-sentence synopsis — this aligns with how embeddings are stored.\n` +
  `  Optional tags enrich the query and serve as fallback filter if no results found.\n` +
  `  Returns array of { id, name, synopsis, tags, links, content, score } — full content included.\n\n` +

  `**zettel_links** { id?, name?, userId }\n` +
  `  Return notes linked from a given note, with full content. Use to explore the note graph.`
