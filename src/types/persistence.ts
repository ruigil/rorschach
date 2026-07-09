import { createTopic } from '../system/index.ts'
import type { ActorRef } from '../system/index.ts'

// ─── Shared response types ───

export type PResult<T = void> = { ok: true; data?: T } | { ok: false; error: string }
export type PList           = { ok: true; keys: string[] }  | { ok: false; error: string }

// ═══════════════════════════════════════════════════════════════════════════
//  KV Store — atomic get/put/delete for serializable state blobs.
//  Used by: actor PersistenceAdapter
// ═══════════════════════════════════════════════════════════════════════════

export type PKVPut    = { type: 'kv.put';    key: string; value: unknown; replyTo?: ActorRef<PResult> }
export type PKVGet    = { type: 'kv.get';    key: string; replyTo: ActorRef<PResult<unknown>> }
export type PKVDelete = { type: 'kv.delete'; key: string; replyTo?: ActorRef<PResult> }
export type PKVList   = { type: 'kv.list';   prefix: string; replyTo: ActorRef<PList> }

// ═══════════════════════════════════════════════════════════════════════════
//  Document Store — whole-document CRUD with append semantics.
//  Used by: journal .md, todos.json, workflow .json, habits.json,
//           artifacts .html, memory records .md, JSONL logs, cost/trace files
// ═══════════════════════════════════════════════════════════════════════════

export type PDocPut    = { type: 'doc.put';    collection: string; docId: string;
                           content: string; replyTo?: ActorRef<PResult> }
export type PDocGet    = { type: 'doc.get';    collection: string; docId: string;
                           replyTo: ActorRef<PResult<string>> }
export type PDocDelete = { type: 'doc.delete'; collection: string; docId: string;
                           replyTo?: ActorRef<PResult> }
export type PDocAppend = { type: 'doc.append'; collection: string; docId: string;
                           content: string; replyTo?: ActorRef<PResult> }
export type PDocList   = { type: 'doc.list';   collection: string; prefix?: string;
                           replyTo: ActorRef<PList> }
export type PDocHead   = { type: 'doc.head';   collection: string; docId: string;
                           replyTo: ActorRef<PResult<{ exists: boolean; size?: number;
                                                         modifiedAt?: string }>> }

// ═══════════════════════════════════════════════════════════════════════════
//  Object (Blob) Store — binary payloads with metadata, in named buckets.
//  Used by: audio .wav, generated .png/.jpg, downloaded files, .mp4 video,
//           inbound media uploads, HTTP file serving
// ═══════════════════════════════════════════════════════════════════════════

export type PObjMeta = Record<string, string>
export type PObjGetPayload = { data: Uint8Array; meta: PObjMeta }
export type PObjGetUrlPayload = { url: string; meta: PObjMeta }

export type PObjPut    = { type: 'obj.put';    bucket: string; key: string;
                           data: Uint8Array; meta?: PObjMeta; replyTo?: ActorRef<PResult> }
export type PObjGet    = { type: 'obj.get';    bucket: string; key: string;
                           replyTo: ActorRef<PResult<PObjGetPayload>> }
export type PObjGetUrl = { type: 'obj.getUrl'; bucket: string; key: string;
                           replyTo: ActorRef<PResult<PObjGetUrlPayload>> }
export type PObjHead   = { type: 'obj.head';   bucket: string; key: string;
                           replyTo: ActorRef<PResult<PObjMeta>> }
export type PObjDelete = { type: 'obj.delete'; bucket: string; key: string;
                           replyTo?: ActorRef<PResult> }
export type PObjList   = { type: 'obj.list';   bucket: string; prefix?: string;
                           replyTo: ActorRef<PList> }

// ═══════════════════════════════════════════════════════════════════════════
//  Graph Store — GrafeoDB embedded inside the persistence.
//  Used by: memory/kgraph (concept nodes, relationships, vector search)
// ═══════════════════════════════════════════════════════════════════════════

export type GraphNode  = { id: string; type: string; properties: Record<string, unknown>;
                           embedding?: number[] }
export type GraphEdge  = { source: string; target: string; type: string;
                           properties?: Record<string, unknown> }

export type PGraphUpsert = { type: 'graph.upsert'; graphId: string;
                             nodes: GraphNode[]; edges: GraphEdge[];
                             replyTo?: ActorRef<PResult<{ nodeIds: string[] }>> }
export type PGraphSearch = { type: 'graph.search'; graphId: string;
                             embedding: number[]; topK: number;
                             replyTo: ActorRef<PResult<GraphNode[]>> }
export type PGraphQuery  = { type: 'graph.query';  graphId: string;
                             cypher: string; params: Record<string, unknown>;
                             replyTo: ActorRef<PResult<Record<string, unknown>[]>> }
export type PGraphDelete = { type: 'graph.delete'; graphId: string;
                              nodeIds: string[]; replyTo?: ActorRef<PResult> }

// ─── Aggregate message union ───

export type PersistenceMsg =
  | PKVPut | PKVGet | PKVDelete | PKVList
  | PDocPut | PDocGet | PDocDelete | PDocAppend | PDocList | PDocHead
  | PObjPut | PObjGet | PObjGetUrl | PObjHead | PObjDelete | PObjList
  | PGraphUpsert | PGraphSearch | PGraphQuery | PGraphDelete

// ─── Discovery (retained topic) ───

export type PersistenceProviderEvent = { ref: ActorRef<PersistenceMsg> | null }
export const PersistenceProviderTopic = createTopic<PersistenceProviderEvent>(
  'persistence.provider',
)
