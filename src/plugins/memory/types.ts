import type { ActorIdentity, ActorRef } from '../../system/index.ts'
import type { LoopMsg } from '../../system/index.ts'
import type { ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import type { LlmProviderMsg, LlmProviderReply } from '../../types/llm.ts'
import type { ContextTurn } from '../../types/agents.ts'
import type { MessageAttachment } from '../../types/events.ts'

// ─── Graph dump types ───

export type KgraphNode = { id: number; labels: string[]; properties: Record<string, unknown> }
export type KgraphEdge = { id: number; type: string; source: number; target: number; properties: Record<string, unknown> }
export type KgraphGraph = { nodes: KgraphNode[]; edges: KgraphEdge[] }

// ─── Memory record types ───

export type MemoryRecordMeta = {
  recordId:     string
  createdAt:    string
  title?:       string
  attachments?: MessageAttachment[]
}

export type MemoryRecord = MemoryRecordMeta & {
  content: string
}

export const MEMORY_CONCEPT_KINDS = [
  'person',
  'project',
  'preference',
  'decision',
  'task',
  'event',
  'tool',
  'place',
  'constraint',
  'fact',
] as const
export type MemoryConceptKind = typeof MEMORY_CONCEPT_KINDS[number]

export const MEMORY_LINK_TYPES = [
  'SAME_AS',
  'ABOUT',
  'PART_OF',
  'CONSTRAINS',
  'DEPENDS_ON',
  'CONTRADICTS',
  'PRECEDES',
  'CAUSES',
] as const
export type MemoryLinkType = typeof MEMORY_LINK_TYPES[number]

export type MemoryConcept = {
  name:         string
  kind:         MemoryConceptKind
  description:  string
  topics:       string[]
  aliases?:     string[]
  eventTime?:   string
}

export type MemoryConceptLink = {
  from:        string
  to:          string
  type:        MemoryLinkType
  confidence?: number
}

export type MemorySearchLinkStub = {
  type: string
  nodeId: number
  name: string
  kind?: string
  confidence?: number
}

export type MemorySearchConcept = {
  nodeId: number
  score?: number
  name: string
  kind?: string
  description: string
  topics?: string[]
  aliases?: string[]
  eventTime?: string
  recordIds: string[]
  links: MemorySearchLinkStub[]
}

export type ConceptSearchReply =
  | { type: 'conceptSearchResult'; concepts: MemorySearchConcept[] }
  | { type: 'conceptSearchError';  error: string }

export type ConceptUpsertReply =
  | { type: 'conceptUpsertResult'; nodeId: number }
  | { type: 'conceptUpsertError'; error: string }

export type ConceptLinksReply =
  | { type: 'conceptLinksResult'; linked: number }
  | { type: 'conceptLinksError'; error: string }

export type LinkConsolidationReason =
  | 'orphan'
  | 'low_degree'
  | 'no_incoming'
  | 'weak_links'

export type LinkConsolidationCandidate = {
  target:  MemorySearchConcept
  anchors: MemorySearchConcept[]
  reason:  LinkConsolidationReason
}

export type LinkCandidatesReply =
  | { type: 'linkCandidatesResult'; candidates: LinkConsolidationCandidate[] }
  | { type: 'linkCandidatesError'; error: string }

// ─── Kgraph message protocol ───

export type KgraphMsg =
  | { type: 'dump'; replyTo: ActorRef<KgraphGraph>; userId: string }
  | { type: 'conceptSearch'; query: string; topN?: number; linkLimit?: number; userId: string; replyTo: ActorRef<ConceptSearchReply> }
  | { type: 'conceptExpand'; nodeId: number; limit?: number; linkLimit?: number; userId: string; replyTo: ActorRef<ConceptSearchReply> }
  | { type: 'upsertConcept'; concept: MemoryConcept; recordId: string; userId: string; replyTo: ActorRef<ConceptUpsertReply> }
  | { type: 'linkConcepts'; links: MemoryConceptLink[]; userId: string; replyTo: ActorRef<ConceptLinksReply> }
  | { type: 'linkCandidates'; userId: string; limit?: number; anchorsPerTarget?: number; linkLimit?: number; replyTo: ActorRef<LinkCandidatesReply> }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_conceptSearchDone'; concepts: MemorySearchConcept[]; replyTo: ActorRef<ConceptSearchReply> }
  | { type: '_conceptSearchErr';  error: string;                   replyTo: ActorRef<ConceptSearchReply> }
  | { type: '_conceptUpsertDone'; nodeId: number;                  replyTo: ActorRef<ConceptUpsertReply> }
  | { type: '_conceptUpsertErr';  error: string;                   replyTo: ActorRef<ConceptUpsertReply> }
  | { type: '_conceptLinksDone';  linked: number;                  replyTo: ActorRef<ConceptLinksReply> }
  | { type: '_conceptLinksErr';   error: string;                   replyTo: ActorRef<ConceptLinksReply> }
  | { type: '_linkCandidatesDone'; candidates: LinkConsolidationCandidate[]; replyTo: ActorRef<LinkCandidatesReply> }
  | { type: '_linkCandidatesErr';  error: string;                         replyTo: ActorRef<LinkCandidatesReply> }
  | { type: '_dumpDone';          graph: KgraphGraph;          replyTo: ActorRef<KgraphGraph> }
  | { type: '_dumpErr';           error: string;               replyTo: ActorRef<KgraphGraph> }

// ─── Memory worker message protocols ───
// Workers only send `_workerDone` to the supervisor; they never receive it,
// so it does not appear in the worker-internal unions below.

export type MemoryRecallMsg =
  | LoopMsg
  | ToolInvokeMsg
  | { type: '_localToolDone'; replyTo: ActorRef<ToolReply>; text: string }
  | { type: '_localToolErr'; replyTo: ActorRef<ToolReply>; error: string }
  | { type: '_fallbackSources'; sources: MemoryRecord[]; userId: string }
  | { type: '_fallbackErr'; error: string }

export type MemoryStoreMsg =
  | LlmProviderReply
  | ToolInvokeMsg
  | { type: '_recordStored'; replyTo: ActorRef<ToolReply>; record: MemoryRecord; topic?: string; userId: string }
  | { type: '_recordStoreErr'; replyTo: ActorRef<ToolReply>; error: string }
  | { type: '_indexed'; summary: string }
  | { type: '_indexErr'; error: string }

// ─── Memory supervisor message protocol ───

export type MemorySupervisorMsg =
  | ToolInvokeMsg
  | { type: '_workerDone';  worker: ActorIdentity }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }

// ─── Memory records message protocol ───

export type MemoryRecordsMsg =
  | ToolInvokeMsg
  | { type: 'create'; content: string; title?: string; attachments?: MessageAttachment[]; userId: string; replyTo: ActorRef<MemoryRecord | { error: string }> }
  | { type: 'readMany'; recordIds: string[]; userId: string; replyTo: ActorRef<MemoryRecord[]> }
  | { type: '_created'; replyTo: ActorRef<MemoryRecord | { error: string }>; record: MemoryRecord }
  | { type: '_createErr'; replyTo: ActorRef<MemoryRecord | { error: string }>; error: string }
  | { type: '_readManyDone'; replyTo: ActorRef<MemoryRecord[]>; records: MemoryRecord[] }
  | { type: '_readManyErr'; replyTo: ActorRef<MemoryRecord[]>; error: string }
  | { type: '_persistenceRef'; ref: ActorRef<any> | null }

// ─── Memory consolidation message protocol ───

// Supervisor: subscribes to topics + timer, routes full turn snapshots to per-user workers.
export type MemoryConsolidationMsg =
  | LlmProviderReply
  | { type: '_contextSnapshot';  userId: string; turns: ContextTurn[] }
  | { type: '_consolidate' }
  | { type: '_llmProvider';      ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_linkCandidatesDone'; userId: string; candidates: LinkConsolidationCandidate[] }
  | { type: '_linkCandidatesErr';  userId: string; error: string }
  | { type: '_linksWritten';       userId: string; linked: number }
  | { type: '_linksWriteErr';      userId: string; error: string }

// Worker: one per user, runs the agentic loop over the latest turn snapshot.
export type UserConsolidationWorkerMsg =
  | LoopMsg
  | { type: '_contextTurns'; turns: ContextTurn[] }
  | { type: '_consolidate' }
