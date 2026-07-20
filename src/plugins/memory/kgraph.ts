import type { ActorDef, ActorRef } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import type { EmbeddingReply, LlmProviderMsg, RerankReply } from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import { PersistenceProviderTopic } from '../../types/persistence.ts'
import type { PersistenceMsg, GraphNode, GraphEdge, PResult } from '../../types/persistence.ts'
import { HttpWsFrameTopic, OutboundUserMessageTopic } from '../../types/events.ts'
import type {
  KgraphGraph,
  KgraphMsg,
  LinkConsolidationCandidate,
  LinkConsolidationReason,
  MemoryConcept,
  MemoryConceptLink,
  MemorySearchConcept,
  MemorySearchLinkStub,
} from './types.ts'
import { ask } from '../../system/index.ts'
export type { KgraphGraph, KgraphMsg }

// ─── Constants ───

type EmbeddingConfig = { model: string; dimensions: number }
type RerankerConfig = { model: string; topK?: number }

type ConceptVectorMatch = {
  nodeId: number
  score: number
  name: string
  description: string
  recordIds: string[]
  topics: string[]
  aliases: string[]
  eventTime?: string
  kind?: string
}

type WeakConceptTarget = {
  concept: MemorySearchConcept
  reason: LinkConsolidationReason
  incomingLinks: number
  outgoingLinks: number
  totalLinks: number
}

// ─── State ───

export type KgraphState = {
  persistenceRef: ActorRef<PersistenceMsg> | null
  llmRef: ActorRef<LlmProviderMsg> | null
}

// ─── Helpers ───

const getGraphId = (userId: string): string => `kgraph/${userId}`

const definedEntries = (properties: Record<string, unknown>): Array<[string, unknown]> =>
  Object.entries(properties).filter(([, value]) => value !== undefined)

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

const uniqueStrings = (values: string[]): string[] => Array.from(new Set(values.filter(Boolean)))

const linkWeight = (type: string): number => {
  switch (type) {
    case 'SAME_AS': return 1.0
    case 'ABOUT': return 0.95
    case 'PART_OF': return 0.85
    case 'CONSTRAINS': return 0.8
    case 'DEPENDS_ON': return 0.7
    case 'CONTRADICTS': return 0.65
    case 'PRECEDES': return 0.55
    case 'CAUSES': return 0.5
    default: return 0
  }
}

const conceptFromVectorMatch = (match: ConceptVectorMatch): MemorySearchConcept => {
  return {
    nodeId: match.nodeId,
    score: match.score,
    name: match.name,
    description: match.description,
    kind: match.kind,
    topics: match.topics,
    aliases: match.aliases,
    eventTime: match.eventTime,
    recordIds: match.recordIds,
    links: [],
  }
}

const conceptFromRow = (row: any): MemorySearchConcept | null => {
  if (typeof row.nodeId !== 'number' || typeof row.name !== 'string') return null
  return {
    nodeId: row.nodeId,
    score: typeof row.score === 'number' ? row.score : undefined,
    name: row.name,
    description: typeof row.description === 'string' ? row.description : '',
    kind: typeof row.kind === 'string' ? row.kind : undefined,
    topics: asStringArray(row.topics),
    aliases: asStringArray(row.aliases),
    eventTime: typeof row.eventTime === 'string' ? row.eventTime : undefined,
    recordIds: asStringArray(row.recordIds),
    links: [],
  }
}

const conceptReturnClause =
  'id(n) AS nodeId, n.name AS name, n.description AS description, n.recordIds AS recordIds, n.topics AS topics, n.aliases AS aliases, n.eventTime AS eventTime, n.kind AS kind'

const fetchLinkStubs = async (
  persistenceRef: ActorRef<PersistenceMsg>,
  graphId: string,
  nodeId: number,
  linkLimit: number,
): Promise<MemorySearchLinkStub[]> => {
  const returnClause =
    'type(r) AS type, id(other) AS nodeId, other.name AS name, other.kind AS kind, r.confidence AS confidence'
  const limit = Math.max(1, linkLimit)

  const [outboundRes, inboundRes] = await Promise.all([
    ask<PersistenceMsg, PResult<Record<string, unknown>[]>>(persistenceRef, (replyTo) => ({
      type: 'graph.query',
      graphId,
      cypher: `MATCH (n:Concept)-[r]->(other:Concept) WHERE id(n) = $nodeId RETURN ${returnClause} LIMIT ${limit}`,
      params: { nodeId },
      replyTo,
    })),
    ask<PersistenceMsg, PResult<Record<string, unknown>[]>>(persistenceRef, (replyTo) => ({
      type: 'graph.query',
      graphId,
      cypher: `MATCH (n:Concept)<-[r]-(other:Concept) WHERE id(n) = $nodeId RETURN ${returnClause} LIMIT ${limit}`,
      params: { nodeId },
      replyTo,
    })),
  ])

  const rows = [
    ...(outboundRes.ok && outboundRes.data ? outboundRes.data : []),
    ...(inboundRes.ok && inboundRes.data ? inboundRes.data : []),
  ]

  return rows
    .filter(row => typeof row.nodeId === 'number' && typeof row.name === 'string' && typeof row.type === 'string')
    .sort((a, b) => (
      linkWeight(String(b.type)) * (typeof b.confidence === 'number' ? b.confidence : 0.75)
    ) - (
      linkWeight(String(a.type)) * (typeof a.confidence === 'number' ? a.confidence : 0.75)
    ))
    .slice(0, linkLimit)
    .map(row => ({
      type: row.type as string,
      nodeId: row.nodeId as number,
      name: row.name as string,
      kind: row.kind as string | undefined,
      confidence: row.confidence as number | undefined,
    }))
}

const attachLinkStubs = async (
  persistenceRef: ActorRef<PersistenceMsg>,
  graphId: string,
  concepts: MemorySearchConcept[],
  linkLimit: number,
): Promise<MemorySearchConcept[]> =>
  Promise.all(concepts.map(async concept => ({
    ...concept,
    links: await fetchLinkStubs(persistenceRef, graphId, concept.nodeId, linkLimit),
  })))

const embedText = async (
  llmRef: ActorRef<LlmProviderMsg>,
  embedding: EmbeddingConfig,
  text: string,
): Promise<number[]> => {
  const reply = await ask<LlmProviderMsg, EmbeddingReply>(
    llmRef,
    (replyToEmbed) => ({ type: 'embed', requestId: crypto.randomUUID(), model: embedding.model, text, dimensions: embedding.dimensions, replyTo: replyToEmbed }),
  )
  if (reply.type === 'embeddingError') throw new Error(reply.error)
  return reply.embedding
}

const queryConceptVectors = async (
  persistenceRef: ActorRef<PersistenceMsg>,
  graphId: string,
  vector: number[],
  cosineSimilarityThreshold: number,
  limit: number,
): Promise<ConceptVectorMatch[]> => {
  const vectorStr = `vector([${vector.join(',')}])`
  const query = `
    MATCH (n:Concept)
    WHERE cosine_similarity(n._embedding, ${vectorStr}) > ${cosineSimilarityThreshold}
    RETURN id(n) AS nodeId, n.name AS name, n.description AS description, n.recordIds AS recordIds, n.topics AS topics, n.aliases AS aliases, n.eventTime AS eventTime, n.kind AS kind, cosine_similarity(n._embedding, ${vectorStr}) AS score
    ORDER BY score DESC
    LIMIT ${Math.max(1, limit)}
  `
  const res = await ask<PersistenceMsg, PResult<Record<string, unknown>[]>>(persistenceRef, (replyTo) => ({
    type: 'graph.query',
    graphId,
    cypher: query,
    params: {},
    replyTo,
  }))

  if (!res.ok) {
    throw new Error(res.error)
  }
  if (!res.data) {
    throw new Error('Failed to query concept vectors')
  }

  return res.data.map((row: any) => ({
    nodeId: row.nodeId,
    score: row.score,
    name: row.name ?? '',
    description: row.description ?? '',
    recordIds: asStringArray(row.recordIds),
    topics: asStringArray(row.topics),
    aliases: asStringArray(row.aliases),
    eventTime: typeof row.eventTime === 'string' ? row.eventTime : undefined,
    kind: typeof row.kind === 'string' ? row.kind : undefined,
  }))
}

const rerankConceptMatches = async (
  llmRef: ActorRef<LlmProviderMsg>,
  reranker: RerankerConfig,
  query: string,
  matches: ConceptVectorMatch[],
  onError?: (error: string) => void,
): Promise<ConceptVectorMatch[]> => {
  if (matches.length === 0) return matches
  const rerankReply = await ask<LlmProviderMsg, RerankReply>(
    llmRef,
    (replyToRerank) => ({
      type: 'rerank',
      requestId: crypto.randomUUID(),
      model: reranker.model,
      query,
      documents: matches.map(m => `${m.name}. ${m.description}`),
      topN: matches.length,
      replyTo: replyToRerank,
    }),
  )
  if (rerankReply.type === 'rerankError') {
    onError?.(rerankReply.error)
    return matches
  }
  const scoreMap = new Map<number, number>()
  for (const r of rerankReply.scores) scoreMap.set(r.index, r.score)
  return matches.map((match, index) => ({
    ...match,
    score: scoreMap.get(index) ?? match.score,
  }))
}

const searchConcepts = async (
  persistenceRef: ActorRef<PersistenceMsg>,
  graphId: string,
  llmRef: ActorRef<LlmProviderMsg>,
  embedding: EmbeddingConfig,
  options: {
    query: string
    topN: number
    linkLimit: number
    cosineSimilarityThreshold: number
    reranker?: RerankerConfig
    onRerankError?: (error: string) => void
  },
): Promise<MemorySearchConcept[]> => {
  const fetchLimit = options.reranker
    ? (options.reranker.topK ?? Math.max(options.topN, 10))
    : options.topN
  const vector = await embedText(llmRef, embedding, options.query)
  const vectorMatches = await queryConceptVectors(persistenceRef, graphId, vector, options.cosineSimilarityThreshold, fetchLimit)
  const matches = options.reranker
    ? await rerankConceptMatches(llmRef, options.reranker, options.query, vectorMatches, options.onRerankError)
    : vectorMatches

  const concepts = matches
    .sort((a, b) => b.score - a.score)
    .slice(0, options.topN)
    .map(conceptFromVectorMatch)
  return attachLinkStubs(persistenceRef, graphId, concepts, options.linkLimit)
}

const fetchNeighborConcepts = async (
  persistenceRef: ActorRef<PersistenceMsg>,
  graphId: string,
  nodeId: number,
  limit: number,
): Promise<MemorySearchConcept[]> => {
  const rowLimit = Math.max(1, limit)
  const [res1, res2] = await Promise.all([
    ask<PersistenceMsg, PResult<Record<string, unknown>[]>>(persistenceRef, (replyTo) => ({
      type: 'graph.query',
      graphId,
      cypher: `MATCH (base:Concept)-[r]->(n:Concept) WHERE id(base) = $nodeId RETURN ${conceptReturnClause}, type(r) AS _linkType, r.confidence AS _confidence LIMIT ${rowLimit}`,
      params: { nodeId },
      replyTo,
    })),
    ask<PersistenceMsg, PResult<Record<string, unknown>[]>>(persistenceRef, (replyTo) => ({
      type: 'graph.query',
      graphId,
      cypher: `MATCH (base:Concept)<-[r]-(n:Concept) WHERE id(base) = $nodeId RETURN ${conceptReturnClause}, type(r) AS _linkType, r.confidence AS _confidence LIMIT ${rowLimit}`,
      params: { nodeId },
      replyTo,
    })),
  ])

  const rows = [
    ...(res1.ok && res1.data ? res1.data : []),
    ...(res2.ok && res2.data ? res2.data : []),
  ]

  const seen = new Set<number>()
  const concepts: MemorySearchConcept[] = []
  const ranked = rows
    .map(row => ({ row, rank: linkWeight(String(row._linkType ?? '')) * (typeof row._confidence === 'number' ? row._confidence : 0.75) }))
    .sort((a, b) => b.rank - a.rank)

  for (const { row } of ranked) {
    const concept = conceptFromRow(row)
    if (!concept || seen.has(concept.nodeId)) continue
    seen.add(concept.nodeId)
    concepts.push(concept)
    if (concepts.length >= limit) break
  }
  return concepts
}

const weakConceptTargetFromRow = (row: any): WeakConceptTarget | null => {
  const concept = conceptFromRow(row)
  if (!concept) return null
  return {
    concept,
    reason: 'orphan',
    incomingLinks: typeof row._incoming === 'number' ? row._incoming : 0,
    outgoingLinks: typeof row._outgoing === 'number' ? row._outgoing : 0,
    totalLinks: typeof row._total === 'number' ? row._total : 0,
  }
}

const fetchWeakConceptTargets = async (
  persistenceRef: ActorRef<PersistenceMsg>,
  graphId: string,
  limit: number,
  linkLimit: number,
): Promise<WeakConceptTarget[]> => {
  const cypher = `
    MATCH (n:Concept)
    OPTIONAL MATCH (n)-[r]-()
    OPTIONAL MATCH (n)<-[incoming]-()
    OPTIONAL MATCH (n)-[outgoing]->()
    WITH n,
      count(DISTINCT r) AS total,
      count(DISTINCT incoming) AS incomingCount,
      count(DISTINCT outgoing) AS outgoingCount
    WHERE total = 0
    RETURN ${conceptReturnClause}, total AS _total, incomingCount AS _incoming, outgoingCount AS _outgoing, "orphan" AS _reason
    ORDER BY _total ASC, _incoming ASC, n.name
    LIMIT ${Math.max(1, limit)}
  `
  const res = await ask<PersistenceMsg, PResult<Record<string, unknown>[]>>(persistenceRef, (replyTo) => ({
    type: 'graph.query',
    graphId,
    cypher,
    params: {},
    replyTo,
  }))

  if (!res.ok) {
    throw new Error(res.error)
  }
  if (!res.data) {
    throw new Error('Failed to fetch weak concept targets')
  }

  const targets = res.data
    .map(weakConceptTargetFromRow)
    .filter((target): target is WeakConceptTarget => target !== null)
  const concepts = await attachLinkStubs(persistenceRef, graphId, targets.map(target => target.concept), linkLimit)
  return targets.map((target, index) => ({ ...target, concept: concepts[index]! }))
}

const candidateSearchText = (concept: MemorySearchConcept): string => [
  concept.name,
  concept.kind ? `kind: ${concept.kind}` : '',
  concept.aliases?.length ? `aliases: ${concept.aliases.join(', ')}` : '',
  concept.description,
  concept.topics?.length ? `topics: ${concept.topics.join(', ')}` : '',
].filter(Boolean).join('\n')

const topicOverlap = (a: MemorySearchConcept, b: MemorySearchConcept): number => {
  const aTopics = new Set((a.topics ?? []).map(t => t.toLowerCase()))
  if (aTopics.size === 0) return 0
  return (b.topics ?? []).filter(t => aTopics.has(t.toLowerCase())).length
}

const fetchLinkCandidates = async (
  persistenceRef: ActorRef<PersistenceMsg>,
  graphId: string,
  llmRef: ActorRef<LlmProviderMsg>,
  embedding: EmbeddingConfig,
  cosineSimilarityThreshold: number,
  limit: number,
  anchorsPerTarget: number,
  linkLimit: number,
): Promise<LinkConsolidationCandidate[]> => {
  const weakTargets = await fetchWeakConceptTargets(persistenceRef, graphId, limit, linkLimit)
  const candidates: LinkConsolidationCandidate[] = []
  for (const target of weakTargets) {
    const linkedNodeIds = new Set(target.concept.links.map(link => link.nodeId))
    linkedNodeIds.add(target.concept.nodeId)
    const searchResults = await searchConcepts(
      persistenceRef,
      graphId,
      llmRef,
      embedding,
      {
        query: candidateSearchText(target.concept),
        topN: Math.max(anchorsPerTarget * 4, anchorsPerTarget + 1),
        linkLimit,
        cosineSimilarityThreshold,
      },
    )
    const anchors = searchResults
      .filter(anchor => !linkedNodeIds.has(anchor.nodeId))
      .sort((a, b) => {
        const aScore = (a.score ?? 0) + topicOverlap(target.concept, a) * 0.05 + Math.min(a.links.length, 8) * 0.01
        const bScore = (b.score ?? 0) + topicOverlap(target.concept, b) * 0.05 + Math.min(b.links.length, 8) * 0.01
        return bScore - aScore
      })
      .slice(0, anchorsPerTarget)

    if (anchors.length === 0) continue
    candidates.push({
      target: target.concept,
      anchors,
      reason: target.reason,
    })
  }

  return candidates
}

const readConceptByName = async (
  persistenceRef: ActorRef<PersistenceMsg>,
  graphId: string,
  name: string,
): Promise<{ nodeId: number; recordIds: string[] } | null> => {
  const res = await ask<PersistenceMsg, PResult<Record<string, unknown>[]>>(persistenceRef, (replyTo) => ({
    type: 'graph.query',
    graphId,
    cypher: `MATCH (n:Concept {name: $name}) RETURN id(n) AS nodeId, n.recordIds AS recordIds LIMIT 1`,
    params: { name },
    replyTo,
  }))
  if (!res.ok || !res.data || res.data.length === 0) return null
  const row = res.data[0]
  if (!row || typeof row.nodeId !== 'number') return null
  return { nodeId: row.nodeId, recordIds: asStringArray(row.recordIds) }
}

const conceptProperties = (
  concept: MemoryConcept,
  recordIds: string[],
): Record<string, unknown> => {
  const topics = uniqueStrings((concept.topics ?? []).map(t => t.trim().toLowerCase()))
  const aliases = uniqueStrings((concept.aliases ?? []).map(a => a.trim()))
  return {
    description: concept.description,
    topics,
    aliases,
    eventTime: concept.eventTime,
    kind: concept.kind,
    recordIds,
  }
}

const conceptEmbeddingText = (concept: MemoryConcept, properties: Record<string, unknown>): string => {
  const topics = asStringArray(properties.topics)
  const aliases = asStringArray(properties.aliases)
  return [
    concept.name,
    `kind: ${concept.kind}`,
    aliases.length > 0 ? `aliases: ${aliases.join(', ')}` : '',
    `description: ${concept.description}`,
    topics.length > 0 ? `topics: ${topics.join(', ')}` : '',
  ].filter(Boolean).join('\n')
}

const upsertConceptNode = async (
  persistenceRef: ActorRef<PersistenceMsg>,
  graphId: string,
  llmRef: ActorRef<LlmProviderMsg>,
  embedding: EmbeddingConfig,
  concept: MemoryConcept,
  recordId: string,
): Promise<number> => {
  const existing = await readConceptByName(persistenceRef, graphId, concept.name)
  const recordIds = existing ? uniqueStrings([...existing.recordIds, recordId]) : [recordId]
  const properties = conceptProperties(concept, recordIds)
  const embeddingText = conceptEmbeddingText(concept, properties)
  const vector = await embedText(llmRef, embedding, embeddingText)

  const node: GraphNode = {
    id: concept.name,
    type: 'Concept',
    properties: {
      ...properties,
      name: concept.name,
      updatedAt: new Date().toISOString(),
    },
    embedding: vector,
  }

  if (!existing) {
    node.properties.createdAt = new Date().toISOString()
  }

  // Remove undefined properties
  for (const [k, v] of Object.entries(node.properties)) {
    if (v === undefined) {
      delete node.properties[k]
    }
  }

  const res = await ask<PersistenceMsg, PResult<{ nodeIds: string[] }>>(persistenceRef, (replyTo) => ({
    type: 'graph.upsert',
    graphId,
    nodes: [node],
    edges: [],
    replyTo,
  }))

  if (!res.ok || !res.data || res.data.nodeIds.length === 0) {
    throw new Error(res.ok ? 'Failed to get upserted nodeId' : res.error)
  }
  return Number(res.data.nodeIds[0])
}

const readLinkConfidence = async (
  persistenceRef: ActorRef<PersistenceMsg>,
  graphId: string,
  link: MemoryConceptLink,
): Promise<number | undefined> => {
  const res = await ask<PersistenceMsg, PResult<Record<string, unknown>[]>>(persistenceRef, (replyTo) => ({
    type: 'graph.query',
    graphId,
    cypher: `MATCH (a:Concept {name: $from})-[r:${link.type}]->(b:Concept {name: $to}) RETURN r.confidence AS confidence LIMIT 1`,
    params: { from: link.from, to: link.to },
    replyTo,
  }))
  if (!res.ok || !res.data || res.data.length === 0) return undefined
  const row = res.data[0]
  return row && typeof row.confidence === 'number' ? row.confidence : undefined
}

const linkConceptNodes = async (
  persistenceRef: ActorRef<PersistenceMsg>,
  graphId: string,
  links: MemoryConceptLink[],
): Promise<number> => {
  const edges: GraphEdge[] = []
  for (const link of links) {
    const existingConfidence = await readLinkConfidence(persistenceRef, graphId, link)
    const confidence = link.confidence !== undefined
      ? Math.max(existingConfidence ?? 0, link.confidence)
      : undefined
    edges.push({
      source: link.from,
      target: link.to,
      type: link.type,
      properties: confidence !== undefined ? { confidence } : undefined,
    })
  }

  const res = await ask<PersistenceMsg, PResult<{ nodeIds: string[] }>>(persistenceRef, (replyTo) => ({
    type: 'graph.upsert',
    graphId,
    nodes: [],
    edges,
    replyTo,
  }))

  if (!res.ok) {
    throw new Error(res.error || 'Failed to link concept nodes')
  }

  return links.length
}

// Helper to notify the client that the KGraph has changed (Signal & Pull)
function notifyKgraphChanged(userId: string, ctx: any) {
  ctx.publish(OutboundUserMessageTopic, {
    userId,
    text: JSON.stringify({ type: 'memory.kgraph.changed' }),
  })
}

// Helper to push the full, cleaned KGraph to the user via WebSocket
async function pushKgraphToUser(state: KgraphState, userId: string, ctx: any) {
  if (!state.persistenceRef) return
  const persistenceRef = state.persistenceRef
  const graphId = getGraphId(userId)

  try {
    const [nodesRes, edgesRes] = await Promise.all([
      ask<PersistenceMsg, PResult<Record<string, unknown>[]>>(
        persistenceRef,
        (replyTo) => ({
          type: 'graph.query',
          graphId,
          cypher: 'MATCH (n) RETURN id(n) AS id, labels(n) AS labels, properties(n) AS properties',
          params: {},
          replyTo,
        })
      ),
      ask<PersistenceMsg, PResult<Record<string, unknown>[]>>(
        persistenceRef,
        (replyTo) => ({
          type: 'graph.query',
          graphId,
          cypher: 'MATCH (s)-[r]->(t) RETURN id(r) AS id, type(r) AS type, id(s) AS source, id(t) AS target, properties(r) AS properties',
          params: {},
          replyTo,
        })
      )
    ])

    const nodesData = nodesRes.ok && nodesRes.data ? nodesRes.data : []
    const edgesData = edgesRes.ok && edgesRes.data ? edgesRes.data : []

    const cleanNodes = nodesData.map((row: any) => {
      let properties = { ...(row.properties || {}) }
      if (properties.properties && typeof properties.properties === 'object') {
        properties = { ...properties.properties }
      }
      const cleanProperties: Record<string, any> = {}
      if (properties.id !== undefined) cleanProperties.id = properties.id
      if (properties.name !== undefined) cleanProperties.name = properties.name
      if (properties.description !== undefined) cleanProperties.description = properties.description
      if (properties.topics !== undefined) cleanProperties.topics = properties.topics

      return {
        id: Number(row.id),
        labels: Array.isArray(row.labels) ? row.labels : [],
        properties: cleanProperties,
      }
    })

    const cleanEdges = edgesData.map((row: any) => {
      let properties = { ...(row.properties || {}) }
      if (properties.properties && typeof properties.properties === 'object') {
        properties = { ...properties.properties }
      }
      delete properties._embedding
      return {
        id: Number(row.id),
        type: String(row.type),
        source: Number(row.source),
        target: Number(row.target),
        properties,
      }
    })

    ctx.publish(OutboundUserMessageTopic, {
      userId,
      text: JSON.stringify({
        type: 'memory.kgraph.updated',
        graph: {
          nodes: cleanNodes,
          edges: cleanEdges,
        }
      })
    })
  } catch (err) {
    ctx.log.error('Failed to push kgraph to user', { userId, error: String(err) })
  }
}

// ─── Actor definition ───

export const Kgraph = (
  workPath?: string,
  embedding?: { model: string; dimensions: number },
  cosineSimilarityThreshold = 0.0,
  reranker?: { model: string; topK?: number },
): ActorDef<KgraphMsg, KgraphState> => ({
  initialState: () => ({ persistenceRef: null, llmRef: null }),

  lifecycle: onLifecycle({
    start: async (_state, ctx) => {
      if (embedding) {
        ctx.subscribe(LlmProviderTopic, (e) => ({ type: '_llmProvider' as const, ref: e.ref }))
      }
      ctx.subscribe(PersistenceProviderTopic, (e) => ({ type: '_persistenceRef' as const, ref: e.ref }))
      ctx.subscribe(HttpWsFrameTopic, (e) => ({ type: '_wsFrame' as const, event: e }))

      ctx.log.info('kgraph ready (persistence-delegated mode)')
      return { state: { persistenceRef: null, llmRef: null } }
    },

    stopped: async (state, ctx) => {
      ctx.log.info('kgraph stopped')
      return { state }
    },
  }),

  handler: onMessage<KgraphMsg, KgraphState>({
    _llmProvider: (state, msg) => {
      return { state: { ...state, llmRef: msg.ref } }
    },

    _persistenceRef: (state, msg) => {
      return { state: { ...state, persistenceRef: msg.ref } }
    },

    upsertConcept: (state, message, ctx) => {
      const { concept, recordId, userId, replyTo } = message
      if (!embedding || !state.llmRef) {
        replyTo.send({ type: 'conceptUpsertError', error: 'upsertConcept requires embedding to be configured' })
        return { state }
      }
      if (!state.persistenceRef) {
        replyTo.send({ type: 'conceptUpsertError', error: 'upsertConcept requires persistence to be ready' })
        return { state }
      }
      const persistenceRef = state.persistenceRef
      const graphId = getGraphId(userId)
      const llmRef = state.llmRef
      ctx.log.info('kgraph upsertConcept', { name: concept.name, recordId, userId })
      ctx.pipeToSelf(
        upsertConceptNode(persistenceRef, graphId, llmRef, embedding, concept, recordId),
        (nodeId) => ({ type: '_conceptUpsertDone' as const, nodeId, userId, replyTo }),
        (error) => ({ type: '_conceptUpsertErr' as const, error: String(error), replyTo }),
      )
      return { state }
    },

    linkConcepts: (state, message, ctx) => {
      const { links, userId, replyTo } = message
      if (!state.persistenceRef) {
        replyTo.send({ type: 'conceptLinksError', error: 'linkConcepts requires persistence to be ready' })
        return { state }
      }
      const persistenceRef = state.persistenceRef
      const graphId = getGraphId(userId)
      ctx.log.info('kgraph linkConcepts', { count: links.length, userId })
      ctx.pipeToSelf(
        linkConceptNodes(persistenceRef, graphId, links),
        (linked) => ({ type: '_conceptLinksDone' as const, linked, userId, replyTo }),
        (error) => ({ type: '_conceptLinksErr' as const, error: String(error), replyTo }),
      )
      return { state }
    },

    linkCandidates: (state, message, ctx) => {
      const { userId, limit = 8, anchorsPerTarget = 6, linkLimit = 5, replyTo } = message
      if (!embedding || !state.llmRef) {
        replyTo.send({ type: 'linkCandidatesError', error: 'linkCandidates requires embedding to be configured' })
        return { state }
      }
      if (!state.persistenceRef) {
        replyTo.send({ type: 'linkCandidatesError', error: 'linkCandidates requires persistence to be ready' })
        return { state }
      }
      const persistenceRef = state.persistenceRef
      const graphId = getGraphId(userId)
      const llmRef = state.llmRef
      ctx.pipeToSelf(
        fetchLinkCandidates(
          persistenceRef,
          graphId,
          llmRef,
          embedding,
          cosineSimilarityThreshold,
          limit,
          anchorsPerTarget,
          linkLimit,
        ),
        (candidates) => ({ type: '_linkCandidatesDone' as const, candidates, replyTo }),
        (error) => ({ type: '_linkCandidatesErr' as const, error: String(error), replyTo }),
      )
      return { state }
    },

    conceptSearch: (state, message, ctx) => {
      const { query, topN = 8, linkLimit = 5, userId, replyTo } = message

      if (!embedding || !state?.llmRef) {
        replyTo.send({ type: 'conceptSearchError', error: 'conceptSearch requires embedding to be configured' })
        return { state }
      }
      if (!state.persistenceRef) {
        replyTo.send({ type: 'conceptSearchError', error: 'conceptSearch requires persistence to be ready' })
        return { state }
      }

      const llmRef = state.llmRef
      const persistenceRef = state.persistenceRef
      const graphId = getGraphId(userId)

      ctx.pipeToSelf(
        searchConcepts(persistenceRef, graphId, llmRef, embedding, {
          query,
          topN,
          linkLimit,
          cosineSimilarityThreshold,
          reranker,
          onRerankError: (error) => ctx.log.warn('kgraph conceptSearch rerank failed, using vector scores', { error }),
        }),
        (concepts) => ({ type: '_conceptSearchDone' as const, concepts, replyTo }),
        (error) => ({ type: '_conceptSearchErr' as const, error: String(error), replyTo }),
      )

      return { state }
    },

    conceptExpand: (state, message, ctx) => {
      const { nodeId, limit = 8, linkLimit = 5, userId, replyTo } = message
      if (!state.persistenceRef) {
        replyTo.send({ type: 'conceptSearchError', error: 'conceptExpand requires persistence to be ready' })
        return { state }
      }
      const persistenceRef = state.persistenceRef
      const graphId = getGraphId(userId)

      ctx.pipeToSelf(
        fetchNeighborConcepts(persistenceRef, graphId, nodeId, limit).then(concepts => attachLinkStubs(persistenceRef, graphId, concepts, linkLimit)),
        (concepts) => ({ type: '_conceptSearchDone' as const, concepts, replyTo }),
        (error) => ({ type: '_conceptSearchErr' as const, error: String(error), replyTo }),
      )

      return { state }
    },

    _conceptUpsertDone: (state, message, ctx) => {
      ctx.log.info('kgraph upsertConcept done', { nodeId: message.nodeId })
      message.replyTo.send({ type: 'conceptUpsertResult', nodeId: message.nodeId })
      notifyKgraphChanged(message.userId, ctx)
      return { state }
    },

    _conceptUpsertErr: (state, message, ctx) => {
      ctx.log.error('kgraph upsertConcept failed', { error: message.error })
      message.replyTo.send({ type: 'conceptUpsertError', error: message.error })
      return { state }
    },

    _conceptLinksDone: (state, message, ctx) => {
      ctx.log.info('kgraph linkConcepts done', { linked: message.linked })
      message.replyTo.send({ type: 'conceptLinksResult', linked: message.linked })
      notifyKgraphChanged(message.userId, ctx)
      return { state }
    },

    _conceptLinksErr: (state, message, ctx) => {
      ctx.log.error('kgraph linkConcepts failed', { error: message.error })
      message.replyTo.send({ type: 'conceptLinksError', error: message.error })
      return { state }
    },

    _linkCandidatesDone: (state, message, ctx) => {
      if (message.candidates.length > 0) {
        ctx.log.info('kgraph linkCandidates done', { candidates: message.candidates.length })
      }
      message.replyTo.send({ type: 'linkCandidatesResult', candidates: message.candidates })
      return { state }
    },

    _linkCandidatesErr: (state, message, ctx) => {
      ctx.log.error('kgraph linkCandidates failed', { error: message.error })
      message.replyTo.send({ type: 'linkCandidatesError', error: message.error })
      return { state }
    },

    _conceptSearchDone: (state, message) => {
      message.replyTo.send({ type: 'conceptSearchResult', concepts: message.concepts })
      return { state }
    },

    _conceptSearchErr: (state, message, ctx) => {
      ctx.log.error('kgraph concept search failed', { error: message.error })
      message.replyTo.send({ type: 'conceptSearchError', error: message.error })
      return { state }
    },

    dump: (state, message, ctx) => {
      const { userId } = message
      if (!state.persistenceRef) {
        message.replyTo.send({ nodes: [], edges: [] })
        return { state }
      }
      const persistenceRef = state.persistenceRef
      const graphId = getGraphId(userId)

      ctx.pipeToSelf(
        Promise.all([
          ask<PersistenceMsg, PResult<Record<string, unknown>[]>>(
            persistenceRef,
            (replyTo) => ({
              type: 'graph.query',
              graphId,
              cypher: 'MATCH (n) RETURN id(n) AS id, labels(n) AS labels, properties(n) AS properties',
              params: {},
              replyTo,
            })
          ).then(res => res.ok && res.data ? res.data : []),
          ask<PersistenceMsg, PResult<Record<string, unknown>[]>>(
            persistenceRef,
            (replyTo) => ({
              type: 'graph.query',
              graphId,
              cypher: 'MATCH (s)-[r]->(t) RETURN id(r) AS id, type(r) AS type, id(s) AS source, id(t) AS target, properties(r) AS properties',
              params: {},
              replyTo,
            })
          ).then(res => res.ok && res.data ? res.data : []),
        ]).then(([nodes, edges]) => ({
          nodes: nodes.map((row: any) => {
            let properties = { ...(row.properties || {}) };
            if (properties.properties && typeof properties.properties === 'object') {
              properties = { ...properties.properties };
            }
            delete properties._embedding;
            return {
              id: Number(row.id),
              labels: Array.isArray(row.labels) ? row.labels : [],
              properties,
            };
          }),
          edges: edges.map((row: any) => {
            let properties = { ...(row.properties || {}) };
            if (properties.properties && typeof properties.properties === 'object') {
              properties = { ...properties.properties };
            }
            delete properties._embedding;
            return {
              id: Number(row.id),
              type: String(row.type),
              source: Number(row.source),
              target: Number(row.target),
              properties,
            };
          }),
        })),
        (graph)  => ({ type: '_dumpDone' as const, graph, replyTo: message.replyTo }),
        (error)  => ({ type: '_dumpErr'  as const, error: String(error), replyTo: message.replyTo }),
      )
      return { state }
    },

    _dumpDone: (state, message) => {
      message.replyTo.send(message.graph)
      return { state }
    },

    _dumpErr: (state, message, ctx) => {
      ctx.log.error('kgraph dump failed', { error: message.error })
      message.replyTo.send({ nodes: [], edges: [] })
      return { state }
    },

    _wsFrame: (state, message, ctx) => {
      const { userId, frame } = message.event
      if (frame.type === 'memory.kgraph.request') {
        pushKgraphToUser(state, userId, ctx)
      }
      return { state }
    },
  }),

  supervision: { type: 'restart', maxRetries: 3, withinMs: 60_000, backoffMs: 500, maxBackoffMs: 8_000 },
})
