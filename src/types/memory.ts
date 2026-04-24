import { createTopic } from '../system/types.ts'
import type { ActorRef, SpanHandle } from '../system/types.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from './tools.ts'
import type { LlmProviderMsg, LlmProviderReply } from './llm.ts'

export type CreateNodeResult = { name: string; nodeId: number }

// ─── Zettelkasten note types ───

export type ZettelNote = {
  id:            string
  name:          string
  synopsis:      string
  tags:          string[]
  createdAt:     string
  updatedAt:     string
  path:          string
  links:         string[]
  kgraphNodeId?: number
}

export type ZettelIndex = { notes: ZettelNote[] }

// ─── kgraph vector search types ───

export type VectorSearchMatch = { nodeId: number; distance: number; name: string; description: string }

export type VectorSearchReply =
  | { type: 'vectorSearchResult'; matches: VectorSearchMatch[] }
  | { type: 'vectorSearchError';  error: string }

// ─── Graph dump types ───

export type KgraphNode = { id: number; labels: string[]; properties: Record<string, unknown> }
export type KgraphEdge = { id: number; type: string; source: number; target: number; properties: Record<string, unknown> }
export type KgraphGraph = { nodes: KgraphNode[]; edges: KgraphEdge[] }

// ─── Topic: published (retained) when kgraph actor is spawned/replaced ───

export type KgraphRefEvent = { ref: ActorRef<KgraphMsg> | null }
export const KgraphTopic = createTopic<KgraphRefEvent>('memory.kgraph')

// ─── Kgraph message protocol ───

export type KgraphMsg =
  | ToolInvokeMsg
  | { type: 'dump'; replyTo: ActorRef<KgraphGraph>; userId?: string }
  | { type: 'vectorSearch'; label: string; text: string; topN?: number; userId?: string; replyTo: ActorRef<VectorSearchReply> }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_queryDone';         rows: unknown[];              replyTo: ActorRef<ToolReply>;          span: SpanHandle | null }
  | { type: '_queryErr';          error: string;               replyTo: ActorRef<ToolReply>;          span: SpanHandle | null }
  | { type: '_writeDone';         matched: number;             replyTo: ActorRef<ToolReply>;          span: SpanHandle | null }
  | { type: '_writeErr';          error: string;               replyTo: ActorRef<ToolReply>;          span: SpanHandle | null }
  | { type: '_createNodeDone';    result: CreateNodeResult;    replyTo: ActorRef<ToolReply>;          span: SpanHandle | null }
  | { type: '_createNodeErr';     error: string;               replyTo: ActorRef<ToolReply>;          span: SpanHandle | null }
  | { type: 'updateNode';         nodeId: number; properties: Record<string, unknown>; embeddingText?: string; userId?: string; replyTo: ActorRef<ToolReply> }
  | { type: '_updateNodeDone';    replyTo: ActorRef<ToolReply> }
  | { type: '_updateNodeErr';     error: string;               replyTo: ActorRef<ToolReply> }
  | { type: '_vectorSearchDone';  matches: VectorSearchMatch[]; replyTo: ActorRef<VectorSearchReply> }
  | { type: '_vectorSearchErr';   error: string;               replyTo: ActorRef<VectorSearchReply> }
  | { type: '_dumpDone';          graph: KgraphGraph;          replyTo: ActorRef<KgraphGraph> }
  | { type: '_dumpErr';           error: string;               replyTo: ActorRef<KgraphGraph> }

// ─── Memory recall message protocol ───

export type MemoryRecallMsg =
  | ToolInvokeMsg
  | { type: '_toolResult';       toolCallId: string; toolName: string; reply: ToolReply }
  | { type: '_llmProvider';      ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_toolRegistered';   name: string; schema: ToolSchema; ref: ActorRef<ToolInvokeMsg> }
  | { type: '_toolUnregistered'; name: string }
  | { type: '_workerDone';       worker: ActorRef<MemoryRecallMsg> }
  | LlmProviderReply

// ─── Memory store message protocol ───

export type MemoryStoreMsg =
  | ToolInvokeMsg
  | { type: '_toolResult';       toolCallId: string; toolName: string; reply: ToolReply }
  | { type: '_llmProvider';      ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_toolRegistered';   name: string; schema: ToolSchema; ref: ActorRef<ToolInvokeMsg> }
  | { type: '_toolUnregistered'; name: string }
  | { type: '_workerDone';       worker: ActorRef<MemoryStoreMsg> }
  | LlmProviderReply

// ─── User memory message protocol ───

export type UserMemoryMsg =
  | { type: 'invoke';        toolName: string; arguments: string; replyTo: ActorRef<ToolReply>; userId?: string }
  | { type: '_toolResult';   sessionId: string; toolCallId: string; toolName: string; reply: ToolReply }
  | { type: '_llmProvider';  ref: ActorRef<LlmProviderMsg> | null }
  | LlmProviderReply

// ─── Topic: published (retained) after each context summary generation ───

export type UserContextEvent = { userId: string; summary: string }
export const UserContextTopic = createTopic<UserContextEvent>('memory.user-context')

// ─── Memory consolidation message protocol ───

export type MemoryConsolidationMsg =
  | { type: '_turn';             userId: string; userText: string; assistantText: string; timestamp: number }
  | { type: '_consolidate' }
  | { type: '_llmProvider';      ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_toolRegistered';   name: string; schema: ToolSchema; ref: ActorRef<ToolInvokeMsg> }
  | { type: '_toolUnregistered'; name: string }
  | { type: '_toolResult';       toolCallId: string; toolName: string; reply: ToolReply }
  | LlmProviderReply

// ─── User context message protocol ───

export type UserContextMsg =
  | { type: '_run' }
  | { type: '_toolResult';        toolCallId: string; toolName: string; reply: ToolReply }
  | { type: '_contextSaved';      userId: string }
  | { type: '_contextSaveFailed'; userId: string; error: string }
  | LlmProviderReply

