// ─── Shared knowledge graph ontology ─────────────────────────────────────────
//
// Single source of truth for node labels, relationship types, and conventions.
// Injected into every agent that reads or writes the kgraph so that consolidation
// and recall operate on the same schema.

export const NODE_LABELS = `
Node labels (use exactly these — do not invent new ones):
  :Entity      — the user themselves, or any named person
  :Tool        — software, libraries, frameworks, runtimes, platforms
  :Project     — named initiatives, products, codebases, side projects
  :Concept     — ideas, domains, methodologies, fields of knowledge
  :Preference  — stated likes, dislikes, habits, workflows
  :Goal        — short or long-term aspirations, dreams, targets
  :Place       — locations, cities, countries, venues
  :Event       — notable occurrences, decisions, milestones

Use the broadest applicable label. Avoid synonyms:
  prefer :Tool over :Library, :Framework, :Runtime, :Platform
  prefer :Entity over :Person, :User, :Contact
  prefer :Project over :Product, :Codebase, :Repo`

export const RELATIONSHIP_TYPES = `
Relationship types (use exactly these — do not invent new ones):
  :USES        — entity uses a tool or technology
  :WORKS_ON    — entity is actively working on a project
  :HAS_GOAL    — entity has a goal or aspiration
  :KNOWS       — entity knows a person
  :PREFERS     — entity prefers something (tool, style, approach)
  :BELIEVES    — entity holds a belief or value
  :LOCATED_IN  — entity is based in a place
  :ATTENDED    — entity attended an event or place
  :OWNS        — entity owns something (boat, device, certification)
  :PART_OF     — project or concept belongs to a larger context`

export const GRAPH_CONVENTIONS = `
Graph conventions:
  - Root anchor: every fact about a user hangs off (u:Entity {name:"<userId>"})
  - All relationships MUST carry source_file — the kbase file documenting this fact
    e.g. MERGE (u:Entity {name:"<userId>"})-[:USES {source_file:"/workspace/memory/<userId>/kbase/preferences.md"}]->(t:Tool {name:"Bun"})
  - Always MERGE, never INSERT — prevents duplicates
  - Query and check for contradictions before writing`

// ─── Formatted section for prompt injection ───────────────────────────────────

export const ontologySection = (userId: string): string =>
  `### Knowledge Graph Schema\n\n` +
  NODE_LABELS + '\n\n' +
  RELATIONSHIP_TYPES + '\n\n' +
  GRAPH_CONVENTIONS.replace(/<userId>/g, userId)
