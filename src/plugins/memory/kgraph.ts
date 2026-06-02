import { GrafeoDB } from '@grafeo-db/js'
import type { ActorDef, ActorRef } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import type { EmbeddingReply, LlmProviderMsg, RerankReply } from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
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

const VECTOR_INDEX_LABEL = 'Concept'

type EmbeddingConfig = { model: string; dimensions: number }
type RerankerConfig = { model: string; topK?: number }

type UserGraphDb = {
  db: GrafeoDB
  vectorIndexReadyFor?: number
  vectorIndexInit?: Promise<void>
}

type ConceptVectorMatch = {
  nodeId: number
  score: number
  name: string
  description: string
  recordIds: string[]
  topics: string[]
  aliases: string[]
  evidence?: string
  eventTime?: string
  kind?: string
}

type CreatedGraphNode = { name: string; nodeId: number }

// ─── State ───

export type KgraphState = {
  userDbs: Map<string, UserGraphDb>
  llmRef: ActorRef<LlmProviderMsg> | null
}

// ─── Helpers ───

const resolveDb = (state: KgraphState, userId: string, workPath: string): UserGraphDb => {
  const existing = state.userDbs.get(userId)
  if (existing) return existing
  const userWorkPath = `${workPath}/${userId}/kgraph`
  const db = GrafeoDB.create(userWorkPath)
  const entry = { db }
  state.userDbs.set(userId, entry)
  return entry
}

const ensureVectorIndex = async (entry: UserGraphDb, embedding: EmbeddingConfig): Promise<void> => {
  if (entry.vectorIndexReadyFor === embedding.dimensions) return
  if (!entry.vectorIndexInit) {
    entry.vectorIndexInit = entry.db
      .execute(`CREATE VECTOR INDEX idx_concept_embedding ON :${VECTOR_INDEX_LABEL}(_embedding) DIMENSION ${embedding.dimensions} METRIC 'cosine'`)
      .then(() => {
        entry.vectorIndexReadyFor = embedding.dimensions
      })
      .catch(() => {
        entry.vectorIndexReadyFor = embedding.dimensions
      })
      .finally(() => {
        entry.vectorIndexInit = undefined
      })
  }
  await entry.vectorIndexInit
}

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
    evidence: match.evidence,
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
    evidence: typeof row.evidence === 'string' ? row.evidence : undefined,
    eventTime: typeof row.eventTime === 'string' ? row.eventTime : undefined,
    recordIds: asStringArray(row.recordIds),
    links: [],
  }
}

const conceptReturnClause =
  'id(n) AS nodeId, n.name AS name, n.description AS description, n.recordIds AS recordIds, n.topics AS topics, n.aliases AS aliases, n.evidence AS evidence, n.eventTime AS eventTime, n.kind AS kind'

const fetchLinkStubs = async (
  db: GrafeoDB,
  nodeId: number,
  linkLimit: number,
): Promise<MemorySearchLinkStub[]> => {
  const returnClause =
    'type(r) AS type, id(other) AS nodeId, other.name AS name, other.kind AS kind, r.confidence AS confidence'
  const limit = Math.max(1, linkLimit)
  const rows = (await Promise.all([
    db.execute(`MATCH (n:Concept)-[r]->(other:Concept) WHERE id(n) = ${nodeId} RETURN ${returnClause} LIMIT ${limit}`),
    db.execute(`MATCH (n:Concept)<-[r]-(other:Concept) WHERE id(n) = ${nodeId} RETURN ${returnClause} LIMIT ${limit}`),
  ])).flatMap(result => result.toArray() as any[])

  return rows
    .filter(row => typeof row.nodeId === 'number' && typeof row.name === 'string' && typeof row.type === 'string')
    .sort((a, b) => (
      linkWeight(String(b.type)) * (typeof b.confidence === 'number' ? b.confidence : 0.75)
    ) - (
      linkWeight(String(a.type)) * (typeof a.confidence === 'number' ? a.confidence : 0.75)
    ))
    .slice(0, linkLimit)
    .map(row => ({
      type: row.type,
      nodeId: row.nodeId,
      name: row.name,
      kind: row.kind,
      confidence: row.confidence,
    }))
}

const attachLinkStubs = async (
  db: GrafeoDB,
  concepts: MemorySearchConcept[],
  linkLimit: number,
): Promise<MemorySearchConcept[]> =>
  Promise.all(concepts.map(async concept => ({
    ...concept,
    links: await fetchLinkStubs(db, concept.nodeId, linkLimit),
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
  db: GrafeoDB,
  vector: number[],
  cosineSimilarityThreshold: number,
  limit: number,
): Promise<ConceptVectorMatch[]> => {
  const vectorStr = `vector([${vector.join(',')}])`
  const seedResult = await db.execute(`
    MATCH (n:Concept)
    WHERE cosine_similarity(n._embedding, ${vectorStr}) > ${cosineSimilarityThreshold}
    RETURN id(n) AS nodeId, n.name AS name, n.description AS description, n.recordIds AS recordIds, n.topics AS topics, n.aliases AS aliases, n.evidence AS evidence, n.eventTime AS eventTime, n.kind AS kind, cosine_similarity(n._embedding, ${vectorStr}) AS score
    ORDER BY score DESC
    LIMIT ${Math.max(1, limit)}
  `)
  return seedResult.toArray().map((row: any) => ({
    nodeId: row.nodeId ?? row['id(n)'],
    score: row.score ?? row['cosine_similarity(n._embedding, ' + vectorStr + ')'],
    name: row.name ?? '',
    description: row.description ?? '',
    recordIds: asStringArray(row.recordIds),
    topics: asStringArray(row.topics),
    aliases: asStringArray(row.aliases),
    evidence: typeof row.evidence === 'string' ? row.evidence : undefined,
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
  entry: UserGraphDb,
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
  await ensureVectorIndex(entry, embedding)
  const fetchLimit = options.reranker
    ? (options.reranker.topK ?? Math.max(options.topN, 10))
    : options.topN
  const vector = await embedText(llmRef, embedding, options.query)
  const vectorMatches = await queryConceptVectors(entry.db, vector, options.cosineSimilarityThreshold, fetchLimit)
  const matches = options.reranker
    ? await rerankConceptMatches(llmRef, options.reranker, options.query, vectorMatches, options.onRerankError)
    : vectorMatches

  const concepts = matches
    .sort((a, b) => b.score - a.score)
    .slice(0, options.topN)
    .map(conceptFromVectorMatch)
  return attachLinkStubs(entry.db, concepts, options.linkLimit)
}

const fetchNeighborConcepts = async (
  db: GrafeoDB,
  nodeId: number,
  limit: number,
): Promise<MemorySearchConcept[]> => {
  const rowLimit = Math.max(1, limit)
  const rows = (await Promise.all([
    db.execute(`MATCH (base:Concept)-[r]->(n:Concept) WHERE id(base) = ${nodeId} RETURN ${conceptReturnClause}, type(r) AS _linkType, r.confidence AS _confidence LIMIT ${rowLimit}`),
    db.execute(`MATCH (base:Concept)<-[r]-(n:Concept) WHERE id(base) = ${nodeId} RETURN ${conceptReturnClause}, type(r) AS _linkType, r.confidence AS _confidence LIMIT ${rowLimit}`),
  ])).flatMap(result => result.toArray() as any[])

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

type ConceptDegree = {
  incoming: number
  outgoing: number
  total: number
  weakConfidenceLinks: number
}

const conceptDegree = async (db: GrafeoDB, nodeId: number): Promise<ConceptDegree> => {
  const [outgoingRows, incomingRows] = await Promise.all([
    db.execute(`MATCH (n:Concept)-[r]->() WHERE id(n) = ${nodeId} RETURN r.confidence AS confidence`),
    db.execute(`MATCH (n:Concept)<-[r]-() WHERE id(n) = ${nodeId} RETURN r.confidence AS confidence`),
  ])
  const outgoing = outgoingRows.toArray() as Array<{ confidence?: unknown }>
  const incoming = incomingRows.toArray() as Array<{ confidence?: unknown }>
  const links = [...outgoing, ...incoming]
  return {
    incoming: incoming.length,
    outgoing: outgoing.length,
    total: links.length,
    weakConfidenceLinks: links.filter(row => typeof row.confidence !== 'number' || row.confidence < 0.6).length,
  }
}

const consolidationReason = (degree: ConceptDegree): LinkConsolidationReason | null => {
  if (degree.total === 0) return 'orphan'
  if (degree.incoming === 0) return 'no_incoming'
  if (degree.total <= 1) return 'low_degree'
  if (degree.weakConfidenceLinks === degree.total) return 'weak_links'
  return null
}

const fetchAllConcepts = async (
  db: GrafeoDB,
  scanLimit: number,
): Promise<MemorySearchConcept[]> => {
  const result = await db.execute(`MATCH (n:Concept) RETURN ${conceptReturnClause} LIMIT ${Math.max(1, scanLimit)}`)
  const concepts = (result.toArray() as any[])
    .map(conceptFromRow)
    .filter((concept): concept is MemorySearchConcept => concept !== null)
  return attachLinkStubs(db, concepts, 20)
}

const candidateSearchText = (concept: MemorySearchConcept): string => [
  concept.name,
  concept.kind ? `kind: ${concept.kind}` : '',
  concept.aliases?.length ? `aliases: ${concept.aliases.join(', ')}` : '',
  concept.description,
  concept.topics?.length ? `topics: ${concept.topics.join(', ')}` : '',
  concept.evidence ? `evidence: ${concept.evidence}` : '',
].filter(Boolean).join('\n')

const topicOverlap = (a: MemorySearchConcept, b: MemorySearchConcept): number => {
  const aTopics = new Set((a.topics ?? []).map(t => t.toLowerCase()))
  if (aTopics.size === 0) return 0
  return (b.topics ?? []).filter(t => aTopics.has(t.toLowerCase())).length
}

const fetchLinkCandidates = async (
  entry: UserGraphDb,
  llmRef: ActorRef<LlmProviderMsg>,
  embedding: EmbeddingConfig,
  cosineSimilarityThreshold: number,
  limit: number,
  anchorsPerTarget: number,
  linkLimit: number,
): Promise<LinkConsolidationCandidate[]> => {
  const scanLimit = Math.max(limit * 8, 32)
  const concepts = await fetchAllConcepts(entry.db, scanLimit)
  const weakTargets: Array<{ concept: MemorySearchConcept; degree: ConceptDegree; reason: LinkConsolidationReason }> = []

  for (const concept of concepts) {
    const degree = await conceptDegree(entry.db, concept.nodeId)
    const reason = consolidationReason(degree)
    if (reason) weakTargets.push({ concept, degree, reason })
  }

  weakTargets.sort((a, b) => {
    if (a.degree.total !== b.degree.total) return a.degree.total - b.degree.total
    if (a.degree.incoming !== b.degree.incoming) return a.degree.incoming - b.degree.incoming
    return a.concept.name.localeCompare(b.concept.name)
  })

  const candidates: LinkConsolidationCandidate[] = []
  for (const target of weakTargets.slice(0, limit)) {
    const linkedNodeIds = new Set(target.concept.links.map(link => link.nodeId))
    linkedNodeIds.add(target.concept.nodeId)
    const searchResults = await searchConcepts(
      entry,
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
  db: GrafeoDB,
  name: string,
): Promise<{ nodeId: number; recordIds: string[] } | null> => {
  const result = await db.execute(
    `MATCH (n:Concept {name:${JSON.stringify(name)}}) RETURN id(n) AS nodeId, n.recordIds AS recordIds LIMIT 1`,
  )
  const row = result.toArray()[0] as { nodeId?: number; recordIds?: unknown } | undefined
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
    evidence: concept.evidence,
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
    concept.evidence ? `evidence: ${concept.evidence}` : '',
  ].filter(Boolean).join('\n')
}

const createGraphNode = async (
  entry: UserGraphDb,
  llmRef: ActorRef<LlmProviderMsg>,
  embedding: EmbeddingConfig,
  label: string,
  name: string,
  properties: Record<string, unknown>,
  embeddingText: string,
): Promise<CreatedGraphNode> => {
  await ensureVectorIndex(entry, embedding)
  const vector = await embedText(llmRef, embedding, embeddingText)

  const now = new Date().toISOString()
  const vectorStr = `vector([${vector.join(',')}])`
  let insertQuery = `INSERT (n:${label} { name: ${JSON.stringify(name)}, _embedding: ${vectorStr}`
  for (const [k, v] of definedEntries({ ...properties, createdAt: now, updatedAt: now })) {
    insertQuery += `, ${k}: ${JSON.stringify(v)}`
  }
  insertQuery += ` }) RETURN n`

  const result = await entry.db.execute(insertQuery)
  const nodeId = result.nodes()[0]?.id
  if (nodeId === undefined) throw new Error('INSERT returned no node')
  return { name, nodeId }
}

const updateGraphNode = async (
  entry: UserGraphDb,
  llmRef: ActorRef<LlmProviderMsg>,
  embedding: EmbeddingConfig,
  nodeId: number,
  properties: Record<string, unknown>,
  embeddingText: string,
): Promise<void> => {
  await ensureVectorIndex(entry, embedding)
  const vector = await embedText(llmRef, embedding, embeddingText)

  const setClauses = [`n._embedding = vector([${vector.join(',')}])`]
  for (const [k, v] of definedEntries(properties)) {
    setClauses.push(`n.${k} = ${JSON.stringify(v)}`)
  }
  setClauses.push(`n.updatedAt = ${JSON.stringify(new Date().toISOString())}`)
  await entry.db.execute(`MATCH (n) WHERE id(n) = ${nodeId} SET ${setClauses.join(', ')}`)
}

const upsertConceptNode = async (
  entry: UserGraphDb,
  llmRef: ActorRef<LlmProviderMsg>,
  embedding: EmbeddingConfig,
  concept: MemoryConcept,
  recordId: string,
): Promise<number> => {
  const existing = await readConceptByName(entry.db, concept.name)
  const recordIds = existing ? uniqueStrings([...existing.recordIds, recordId]) : [recordId]
  const properties = conceptProperties(concept, recordIds)
  const embeddingText = conceptEmbeddingText(concept, properties)

  if (existing) {
    await updateGraphNode(entry, llmRef, embedding, existing.nodeId, properties, embeddingText)
    return existing.nodeId
  }

  const result = await createGraphNode(entry, llmRef, embedding, 'Concept', concept.name, properties, embeddingText)
  return result.nodeId
}

const readLinkConfidence = async (
  db: GrafeoDB,
  link: MemoryConceptLink,
): Promise<number | undefined> => {
  const result = await db.execute(
    `MATCH (a:Concept {name:${JSON.stringify(link.from)}})-[r:${link.type}]->(b:Concept {name:${JSON.stringify(link.to)}}) ` +
    `RETURN r.confidence AS confidence LIMIT 1`,
  )
  const row = result.toArray()[0] as { confidence?: unknown } | undefined
  return typeof row?.confidence === 'number' ? row.confidence : undefined
}

const linkConceptNodes = async (
  db: GrafeoDB,
  links: MemoryConceptLink[],
): Promise<number> => {
  let linked = 0
  for (const link of links) {
    const setClauses: string[] = []
    if (link.confidence !== undefined) {
      const existingConfidence = await readLinkConfidence(db, link)
      const confidence = Math.max(existingConfidence ?? 0, link.confidence)
      setClauses.push(`r.confidence = ${JSON.stringify(confidence)}`)
    }

    const result = await db.execute(
      `MATCH (a:Concept {name:${JSON.stringify(link.from)}}), (b:Concept {name:${JSON.stringify(link.to)}}) ` +
      `MERGE (a)-[r:${link.type}]->(b) ` +
      (setClauses.length > 0 ? `SET ${setClauses.join(', ')} ` : '') +
      `RETURN count(*) AS _n`,
    )
    const row = result.toArray()[0] as { _n?: number } | undefined
    if ((row?._n ?? 0) > 0) linked++
  }
  return linked
}

// ─── Actor definition ───

export const Kgraph = (
  workPath: string,
  embedding?: { model: string; dimensions: number },
  cosineSimilarityThreshold = 0.0,
  reranker?: { model: string; topK?: number },
): ActorDef<KgraphMsg, KgraphState> => ({
  initialState: () => ({ userDbs: new Map(), llmRef: null }),

  lifecycle: onLifecycle({
    start: async (_state, ctx) => {
      if (embedding) {
        ctx.subscribe(LlmProviderTopic, (e) => ({ type: '_llmProvider' as const, ref: e.ref }))
      }

      ctx.log.info('kgraph ready (user-isolated mode)', { workPath })
      return { state: { userDbs: new Map(), llmRef: null } }
    },

    stopped: async (state, ctx) => {
      ctx.log.info('kgraph closing databases')
      const dbs = Array.from(state.userDbs.values())
      for (const entry of dbs) entry.db.close()
      return { state }
    },
  }),

  handler: onMessage<KgraphMsg, KgraphState>({
    _llmProvider: (state, msg) => ({
      state: { ...state, llmRef: msg.ref },
    }),

    upsertConcept: (state, message, ctx) => {
      const { concept, recordId, userId, replyTo } = message
      if (!embedding || !state.llmRef) {
        replyTo.send({ type: 'conceptUpsertError', error: 'upsertConcept requires embedding to be configured' })
        return { state }
      }
      const entry = resolveDb(state, userId, workPath)
      const llmRef = state.llmRef
      ctx.log.info('kgraph upsertConcept', { name: concept.name, recordId, userId })
      ctx.pipeToSelf(
        upsertConceptNode(entry, llmRef, embedding, concept, recordId),
        (nodeId) => ({ type: '_conceptUpsertDone' as const, nodeId, replyTo }),
        (error) => ({ type: '_conceptUpsertErr' as const, error: String(error), replyTo }),
      )
      return { state }
    },

    linkConcepts: (state, message, ctx) => {
      const { links, userId, replyTo } = message
      const entry = resolveDb(state, userId, workPath)
      ctx.log.info('kgraph linkConcepts', { count: links.length, userId })
      ctx.pipeToSelf(
        linkConceptNodes(entry.db, links),
        (linked) => ({ type: '_conceptLinksDone' as const, linked, replyTo }),
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
      const entry = resolveDb(state, userId, workPath)
      const llmRef = state.llmRef
      ctx.log.info('kgraph linkCandidates', { userId, limit, anchorsPerTarget })
      ctx.pipeToSelf(
        fetchLinkCandidates(entry, llmRef, embedding, cosineSimilarityThreshold, limit, anchorsPerTarget, linkLimit),
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

      const llmRef = state.llmRef
      const entry = resolveDb(state, userId, workPath)

      ctx.pipeToSelf(
        searchConcepts(entry, llmRef, embedding, {
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
      const entry = resolveDb(state, userId, workPath)

      ctx.pipeToSelf(
        fetchNeighborConcepts(entry.db, nodeId, limit).then(concepts => attachLinkStubs(entry.db, concepts, linkLimit)),
        (concepts) => ({ type: '_conceptSearchDone' as const, concepts, replyTo }),
        (error) => ({ type: '_conceptSearchErr' as const, error: String(error), replyTo }),
      )

      return { state }
    },

    _conceptUpsertDone: (state, message, ctx) => {
      ctx.log.info('kgraph upsertConcept done', { nodeId: message.nodeId })
      message.replyTo.send({ type: 'conceptUpsertResult', nodeId: message.nodeId })
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
      return { state }
    },

    _conceptLinksErr: (state, message, ctx) => {
      ctx.log.error('kgraph linkConcepts failed', { error: message.error })
      message.replyTo.send({ type: 'conceptLinksError', error: message.error })
      return { state }
    },

    _linkCandidatesDone: (state, message, ctx) => {
      ctx.log.info('kgraph linkCandidates done', { candidates: message.candidates.length })
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
      const entry = resolveDb(state, userId, workPath)

      const nodeQuery = 'MATCH (n) RETURN n'
      const edgeQuery = 'MATCH ()-[r]->() RETURN r'

      ctx.pipeToSelf(
        Promise.all([
          entry.db.execute(nodeQuery),
          entry.db.execute(edgeQuery),
        ]).then(([nodesResult, edgesResult]) => ({
          nodes: nodesResult.nodes().map(n => ({ id: n.id, labels: n.labels, properties: n.properties() as Record<string, unknown> })),
          edges: edgesResult.edges().map(e => ({ id: e.id, type: e.edgeType, source: e.sourceId, target: e.targetId, properties: e.properties() as Record<string, unknown> })),
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
  }),

  supervision: { type: 'restart', maxRetries: 3, withinMs: 60_000, backoffMs: 500, maxBackoffMs: 8_000 },
})
