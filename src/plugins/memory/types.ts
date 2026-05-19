import type { ActorIdentity, ActorRef, SpanHandle } from '../../system/types.ts'
import type { LoopMsg } from '../../system/agent-loop.ts'
import type { ToolFinalReply, ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import type { LlmProviderMsg, LlmProviderReply } from '../../types/llm.ts'

export type CreateNodeResult = { name: string; nodeId: number }

// ─── Graph dump types ───

export type KgraphNode = { id: number; labels: string[]; properties: Record<string, unknown> }
export type KgraphEdge = { id: number; type: string; source: number; target: number; properties: Record<string, unknown> }
export type KgraphGraph = { nodes: KgraphNode[]; edges: KgraphEdge[] }

// ─── Zettelkasten note types ───

export const ZETTEL_LINK_TYPES = [
  'causes', 'caused_by', 'depends_on', 'requires',
  'contains', 'part_of', 'supports', 'contradicts',
  'precedes', 'follows',
] as const
export type ZettelLinkType = typeof ZETTEL_LINK_TYPES[number]

export type ZettelLink = { name: string; type: ZettelLinkType }

export type ZettelNote = {
  id:            string
  name:          string
  synopsis:      string
  tags:          string[]
  createdAt:     string
  updatedAt:     string
  eventTime?:    string
  path:          string
  links:         ZettelLink[]
  kgraphNodeId?: number
}

export type ZettelIndex = { notes: ZettelNote[] }

// ─── kgraph vector search types ───

export type VectorSearchMatch = {
  nodeId: number
  score: number        // final blended score
  name: string
  description: string
}

export type VectorSearchReply =
  | { type: 'vectorSearchResult'; matches: VectorSearchMatch[] }
  | { type: 'vectorSearchError';  error: string }

// ─── Kgraph message protocol ───

export type KgraphMsg =
  | ToolInvokeMsg
  | { type: 'dump'; replyTo: ActorRef<KgraphGraph>; userId: string }
  | {
      type: 'vectorSearch'
      label: string
      text: string
      topN?: number
      userId: string
      replyTo: ActorRef<VectorSearchReply>
      filter?: { before?: string; after?: string; property: string }
    }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_queryDone';         rows: unknown[];              replyTo: ActorRef<ToolReply>;          span: SpanHandle | null }
  | { type: '_queryErr';          error: string;               replyTo: ActorRef<ToolReply>;          span: SpanHandle | null }
  | { type: '_writeDone';         matched: number;             replyTo: ActorRef<ToolReply>;          span: SpanHandle | null }
  | { type: '_writeErr';          error: string;               replyTo: ActorRef<ToolReply>;          span: SpanHandle | null }
  | { type: '_createNodeDone';    result: CreateNodeResult;    replyTo: ActorRef<ToolReply>;          span: SpanHandle | null }
  | { type: '_createNodeErr';     error: string;               replyTo: ActorRef<ToolReply>;          span: SpanHandle | null }
  | { type: 'updateNode';         nodeId: number; properties: Record<string, unknown>; embeddingText?: string; userId: string; replyTo: ActorRef<ToolReply> }
  | { type: '_updateNodeDone';    replyTo: ActorRef<ToolReply> }
  | { type: '_updateNodeErr';     error: string;               replyTo: ActorRef<ToolReply> }
  | { type: '_vectorSearchDone';  matches: VectorSearchMatch[]; replyTo: ActorRef<VectorSearchReply> }
  | { type: '_vectorSearchErr';   error: string;               replyTo: ActorRef<VectorSearchReply> }
  | { type: '_dumpDone';          graph: KgraphGraph;          replyTo: ActorRef<KgraphGraph> }
  | { type: '_dumpErr';           error: string;               replyTo: ActorRef<KgraphGraph> }

// ─── Memory worker message protocols ───
// Workers only send `_workerDone` to the supervisor; they never receive it,
// so it does not appear in the worker-internal unions below.

export type MemoryRecallMsg = LoopMsg | ToolInvokeMsg

export type MemoryStoreMsg = LoopMsg | ToolInvokeMsg

// ─── Memory supervisor message protocol ───

export type MemorySupervisorMsg =
  | ToolInvokeMsg
  | { type: '_workerDone';  worker: ActorIdentity }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }

// ─── Memory consolidation message protocol ───

// Supervisor: subscribes to topics + timer, routes turns to per-user workers.
export type MemoryConsolidationMsg =
  | { type: '_turn';             userId: string; userText: string; assistantText: string; timestamp: number }
  | { type: '_consolidate' }
  | { type: '_llmProvider';      ref: ActorRef<LlmProviderMsg> | null }

// Worker: one per user, runs the agentic loop over a local buffer.
export type UserConsolidationWorkerMsg =
  | LoopMsg
  | { type: '_turn';        userText: string; assistantText: string; timestamp: number }
  | { type: '_consolidate' }
