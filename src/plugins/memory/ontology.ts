// ─── Shared knowledge graph ontology ─────────────────────────────────────────
//
// Single source of truth for node labels, relationship types, and conventions.
// Injected into every agent that reads or writes the kgraph so that consolidation
// and recall operate on the same schema.

export const NODE_LABELS = `
Node labels (use exactly these — do not invent new ones):
  :Entity      — the user themselves, or any named person
  :Project     — named initiatives, products, codebases, side projects
  :Concept     — ideas, domains, methodologies, fields of knowledge
  :Preference  — stated likes, dislikes, habits, workflows
  :Goal        — short or long-term aspirations, dreams, targets
  :Place       — locations, cities, countries, venues
  :Event       — notable occurrences, decisions, milestones
  :Habit       — recurring behaviours and routines

Use the broadest applicable label. Avoid synonyms:
  prefer :Tool over :Library, :Framework, :Runtime, :Platform
  prefer :Entity over :Person, :User, :Contact
  prefer :Project over :Product, :Codebase, :Repo`

export const RELATIONSHIP_TYPES = `
Relationship types (use exactly these — do not invent new ones):

Current-state (fact is true now):
  :WORKS_ON    — entity is actively working on a project          {source_file}
  :HAS_GOAL    — entity has an active goal or aspiration          {source_file}
  :KNOWS       — entity knows a person                           {source_file}
  :PREFERS     — entity currently prefers something              {source_file}
  :BELIEVES    — entity holds a belief or value                  {source_file}
  :LOCATED_IN  — entity is permanently based in a place          {source_file}
  :VISITING    — entity is temporarily present in a place        {source_file}
  :ATTENDED    — entity attended an event or place (inherently past) {source_file}
  :OWNS        — entity owns something                           {source_file}
  :PART_OF     — project or concept belongs to a larger context  {source_file}
  :HAS_HABIT   — entity does something regularly                 {source_file, confidence}

Archive (fact is no longer true — carry {since, source_file}):
  :WORKED_ON      — entity previously worked on a project
  :ACHIEVED_GOAL  — entity achieved this goal
  :ABANDONED_GOAL — entity abandoned this goal
  :PREFERRED      — entity used to prefer this (preference has shifted)
  :LIVED_IN       — entity previously lived in this place
  :HAD_HABIT      — entity previously did this regularly`

export const GRAPH_CONVENTIONS = `
Graph conventions:
  - Root anchor: every fact about a user hangs off (u:Entity {name:"<userId>"})
  - All relationships MUST carry source_file — the kbase file documenting this fact
    e.g. MERGE (u:Entity {name:"<userId>"})-[:PREFERS {source_file:"/workspace/memory/<userId>/kbase/preferences.md"}]->(p:Preference {name:"Bun"})
  - Query and check for contradictions and pending lifecycle transitions before writing

Three graph tools — use each for exactly one purpose:
  kgraph_upsert  — create or update a NODE. Always call this before writing relationships.
                   Returns { canonicalName, nodeId, merged }. Use canonicalName (not the name you
                   passed in) in all subsequent kgraph_write statements — it may differ if an existing
                   node was found via semantic similarity.
                   Extra context goes in properties, not in name:
                     kgraph_upsert { label:"Place", name:"Amor", properties:{ region:"Leiria" } }
  kgraph_write   — MERGE/SET/DELETE RELATIONSHIPS only. Never use it to create bare nodes.
  kgraph_query   — MATCH/RETURN reads only.`

export const LIFECYCLE_RULES = `
### Lifecycle Rules

The graph is a state machine — a snapshot of current state. Transitions are destructive:
DELETE the old relationship, MERGE the new one. History lives in episodic logs and the
\`since\` property on archive relationships, not in the graph itself.

**confidence property** — only on :HAS_HABIT relationships:
  "inferred"  — derived from behavioral pattern by the reflection agent
  "explicit"  — user confirmed it directly (SET r.confidence = "explicit")

**Travel (three-phase)**
  Planning:   (u)-[:HAS_GOAL]->(g:Goal {name:"Trip to X"})
  Travelling: DELETE :HAS_GOAL → MERGE (u)-[:VISITING]->(p:Place {name:"X"})
  Past:       DELETE :VISITING → MERGE :ACHIEVED_GOAL on Goal node
                               + MERGE :ATTENDED on new Event node

**Projects**
  Planning:   (u)-[:HAS_GOAL]->(g:Goal)
  Active:     MERGE :WORKS_ON — :HAS_GOAL stays (goal not yet achieved)
  Completed:  DELETE :WORKS_ON + :HAS_GOAL → MERGE :WORKED_ON + :ACHIEVED_GOAL
  Abandoned:  DELETE :WORKS_ON + :HAS_GOAL → MERGE :WORKED_ON + :ABANDONED_GOAL

**Preferences**
  Exploring:  kbase note only — no graph write until confirmed across multiple sessions
  Active:     MERGE :PREFERS
  Shifted:    DELETE :PREFERS → MERGE :PREFERRED + MERGE new :PREFERS
  Dropped:    DELETE :PREFERS → MERGE :PREFERRED (no replacement)

**Habits (written by the reflection agent only — never by consolidation)**
  Pattern confirmed: MERGE :HAS_HABIT {confidence:"inferred"}
  User confirms:     SET r.confidence = "explicit", remove [inferred] marker in kbase
  Habit ends:        DELETE :HAS_HABIT → MERGE :HAD_HABIT {since}

**Coexistence rule**
  :HAS_GOAL and :WORKS_ON may coexist — they describe different things (aspiration vs. activity).
  All other current-state relationships to the same target node should not coexist.

**Archive immediately (no clarifying question) when transition is unambiguous:**
  - project done, shipped, or cancelled → :WORKED_ON
  - goal achieved or dropped → :ACHIEVED_GOAL / :ABANDONED_GOAL
  - "I moved to X" (explicit relocation) → :LIVED_IN + new :LOCATED_IN
  - "I switched from X to Y" (explicit preference change) → :PREFERRED + new :PREFERS
  - user departs on a planned trip → DELETE :HAS_GOAL, MERGE :VISITING
  - user returns from a trip → DELETE :VISITING, MERGE :ACHIEVED_GOAL + :ATTENDED

**Ask a clarifying question (never archive) when ambiguous:**
  - past-tense mention without a confirmed end
  - new tool mentioned without saying they dropped the old one
  - location mentioned in passing (visiting vs. moving)
  - exploring something without committing ("trying out", "experimenting with")

**Archive Cypher pattern:**
  MATCH (u:Entity {name:"<userId>"})-[r:WORKS_ON]->(p)
  MERGE (u)-[:WORKED_ON {since:"YYYY-MM-DD", source_file:r.source_file}]->(p)
  DELETE r`

// ─── Formatted section for prompt injection ───────────────────────────────────

export const ontologySection = (userId: string): string =>
  `### Knowledge Graph Schema\n\n` +
  NODE_LABELS + '\n\n' +
  RELATIONSHIP_TYPES + '\n\n' +
  GRAPH_CONVENTIONS.replace(/<userId>/g, userId) + '\n\n' +
  LIFECYCLE_RULES.replace(/<userId>/g, userId)
