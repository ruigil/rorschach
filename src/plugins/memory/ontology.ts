// ─── Zettelkasten note schema ─────────────────────────────────────────────────
//
// Single source of truth for the note format and tool usage pattern.
// Injected into every memory agent prompt.

export const zettelSection = (userId: string): string =>
  `### Zettelkasten Note System\n\n` +

  `Notes are stored at /workspace/memory/${userId}/notes/\n` +
  `  index.json — metadata array (id, name, synopsis, tags, createdAt, updatedAt, links)\n` +
  `  {uuid}.md  — individual note files with YAML frontmatter\n\n` +

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
  `\`\`\`\n\n` +

  `### Available tools\n\n` +

  `**zettel_activate** { text, userId }\n` +
  `  Semantic search via vector embeddings — find notes most similar to the given text.\n` +
  `  Returns array of { id, name, synopsis, tags }. Use this first to find relevant notes.\n\n` +

  `**zettel_create** { name, synopsis, content, tags[], userId }\n` +
  `  Create a new atomic note. name: 2-5 words, Title Case. synopsis: one sentence.\n\n` +

  `**zettel_update** { id, content?, name?, synopsis?, tags?, userId }\n` +
  `  Update an existing note. Only pass fields that should change.\n\n` +

  `**zettel_read** { id?, name?, userId }\n` +
  `  Read full note content by id or name.\n\n` +

  `**zettel_list** { tags[]?, userId }\n` +
  `  List note metadata. Optionally filter by tags (must match ALL provided tags).\n\n` +

  `**zettel_search** { query, userId }\n` +
  `  Full-text search across note names, synopses, tags, and content.\n\n` +

  `**zettel_link** { sourceId?, sourceName?, targetId?, targetName?, userId }\n` +
  `  Create a directional link between two notes. Updates metadata and the knowledge graph.\n` +
  `  Both notes must already exist. Call this only after all notes have been created/updated.\n\n` +

  `### A-Mem workflow (one topic at a time)\n` +
  `1. zettel_activate { text: "<topic summary>", userId } → candidate notes\n` +
  `2. zettel_read each candidate to see full content\n` +
  `3. If a candidate already covers this topic → zettel_update (merge new information)\n` +
  `4. If no relevant note exists → zettel_create (new atomic note)\n` +
  `   Repeat steps 1–4 for all topics. Create ALL notes before creating any links.\n` +
  `5. zettel_link { sourceName, targetName, userId } for each relationship between notes.\n` +
  `   Only call zettel_link after both notes are confirmed to exist.\n\n` +

  `### Note writing rules\n` +
  `- One note per concept or fact cluster. Keep notes atomic and self-contained.\n` +
  `- synopsis must accurately summarize the note content — it drives semantic search.\n` +
  `- Tags are lowercase, single-word or hyphenated: ["typescript", "work", "preference"].\n` +
  `- Do not duplicate facts across notes — update the canonical note instead.\n` +
  `- **Strict Link Validation**: NEVER speculate on note titles. Only create links via zettel_link using:\n` +
  `  1. The exact 'name' returned by zettel_activate, zettel_read, or zettel_list.\n` +
  `  2. The exact 'name' of a note you just created with zettel_create in this same turn.\n` +
  `- If you want to link to a concept but don't know if a note exists, use zettel_search or zettel_activate to discover it first.`
