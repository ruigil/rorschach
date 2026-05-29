import { GrafeoDB } from '@grafeo-db/js'
import type { ActorDef, ActorRef } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { defineTool } from '../../system/index.ts'
import type { EmbeddingReply, LlmProviderMsg, RerankReply } from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { KgraphGraph, KgraphMsg, CreateNodeResult, VectorSearchMatch } from './types.ts'
import { ask } from '../../system/index.ts'
export type { KgraphGraph, KgraphMsg }

// ─── Constants ───

// Node labels that get a vector index on startup
const INDEXED_LABELS = ['Note'] as const

// ─── Tool names & schemas ───

export const kgraphQueryTool = defineTool('kgraph_query', 'Run a read-only Cypher query against the persistent knowledge graph. Use MATCH/RETURN clauses only. Returns a JSON array of row objects. Example: MATCH (n:Note {name: "Bun Runtime"}) RETURN n.name, n.description', {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'A Cypher MATCH/RETURN query. Must not contain INSERT, MERGE, SET, or DELETE.',
    },
    userId: {
      type: 'string',
      description: "If provided, operates on this user's isolated knowledge graph at workspace/memory/<userId>/kgraph.",
    },
  },
  required: ['query'],
})

export const kgraphCreateLinkTool = defineTool('kgraph_create_link', 'Execute a Cypher write statement to store or update relationships in the knowledge graph. Use for relationships (MERGE/SET/DELETE) only — use kgraph_create_node to create nodes. Returns "ok" on success. Node constraint: when referencing nodes inline, only "name" and "description" properties are allowed. Example: MERGE (a:Note {name:"Bun Runtime"})-[:LINKS_TO]->(b:Note {name:"TypeScript Preferences"})', {
  type: 'object',
  properties: {
    statement: {
      type: 'string',
      description: 'A Cypher write statement using MERGE, SET, or DELETE for relationships.',
    },
    userId: {
      type: 'string',
      description: "If provided, operates on this user's isolated knowledge graph at workspace/memory/<userId>/kgraph.",
    },
  },
  required: ['statement'],
})

export const kgraphCreateNodeTool = defineTool('kgraph_create_node', 'Create a new node in the knowledge graph. Returns { name, nodeId }. Use nodeId in subsequent kgraph_create_link calls. Node constraint: nodes store "name", "description", and optional "eventTime" (ISO 8601). Put all other detail in the description.', {
  type: 'object',
  properties: {
    label: {
      type: 'string',
      description: 'Node label. Use "Note" for Zettelkasten notes.',
    },
    name: {
      type: 'string',
      description: 'Short node name in Title Case (e.g. "Bun Runtime"). Used as the display name.',
    },
    properties: {
      type: 'object',
      description: 'Pass "description" and optional "eventTime" (ISO 8601). For notes, description format is "noteId:{uuid}\\n{synopsis}".',
      properties: {
        description: { type: 'string' },
        eventTime: { type: 'string', format: 'date-time' },
      },
      additionalProperties: false,
    },
    embeddingText: {
      type: 'string',
      description: 'Optional. If provided, this text is embedded instead of name. Use for richer semantic search (e.g. "{name} {tags} {synopsis}").',
    },
    userId: {
      type: 'string',
      description: "If provided, operates on this user's isolated knowledge graph at workspace/memory/<userId>/kgraph.",
    },
  },
  required: ['label', 'name'],
})

// ─── State ───

export type KgraphState = {
  userDbs: Map<string, GrafeoDB>
  llmRef: ActorRef<LlmProviderMsg> | null
}

// ─── Helpers ───

const resolveDb = (state: KgraphState, userId: string, workPath: string): GrafeoDB => {
  const existing = state.userDbs.get(userId)
  if (existing) return existing
  const userWorkPath = `${workPath}/${userId}/kgraph`
  const db = GrafeoDB.create(userWorkPath)
  state.userDbs.set(userId, db)
  return db
}

const definedEntries = (properties: Record<string, unknown>): Array<[string, unknown]> =>
  Object.entries(properties).filter(([, value]) => value !== undefined)

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
      for (const db of dbs) db.close()
      return { state }
    },
  }),

  handler: onMessage<KgraphMsg, KgraphState>({
    _llmProvider: (state, msg) => ({
      state: { ...state, llmRef: msg.ref },
    }),

    invoke: (state, message, ctx) => {
      const { toolName, arguments: rawArgs, replyTo } = message
      const parent = ctx.trace.fromHeaders()

      if (toolName === kgraphQueryTool.name) {
        const args = JSON.parse(rawArgs) as { query: string; userId?: string }
        const effectiveUserId = args.userId ?? message.userId
        ctx.log.info('kgraph query', { query: args.query, userId: effectiveUserId })
        const span = parent
          ? ctx.trace.child(parent.traceId, parent.spanId, kgraphQueryTool.name, { query: args.query })
          : null
        const db = resolveDb(state, effectiveUserId, workPath)

        ctx.pipeToSelf(
          db.execute(args.query).then(r => r.rows() as unknown[]),
          (rows)  => ({ type: '_queryDone' as const, rows, replyTo, span }),
          (error) => ({ type: '_queryErr'  as const, error: String(error), replyTo, span }),
        )

      } else if (toolName === kgraphCreateLinkTool.name) {
        const args = JSON.parse(rawArgs) as { statement: string; userId?: string }
        const effectiveUserId = args.userId ?? message.userId
        ctx.log.info('kgraph create_link', { statement: args.statement, userId: effectiveUserId })
        const span = parent
          ? ctx.trace.child(parent.traceId, parent.spanId, kgraphCreateLinkTool.name, { statement: args.statement })
          : null
        const db = resolveDb(state, effectiveUserId, workPath)

        // Strip // line comments — GrafeoDB Cypher doesn't support them and
        // the LLM occasionally adds them as inline annotations.
        const cleaned = args.statement.replace(/\/\/[^\n]*/g, '').trim()

        // Append RETURN count(*) if absent so we can detect silent no-ops
        // (MATCH returns 0 rows when a referenced node doesn't exist yet).
        const hasReturn = /\bRETURN\b/i.test(cleaned)
        const query = hasReturn
          ? cleaned
          : cleaned + '\nRETURN count(*) AS _n'

        ctx.pipeToSelf(
          db.execute(query).then(result => {
            if (hasReturn) return -1  // unknown — statement has its own RETURN
            const row = result.toArray()[0] as { _n?: number } | undefined
            return row?._n ?? 0
          }),
          (matched) => ({ type: '_writeDone' as const, matched, replyTo, span }),
          (error)   => ({ type: '_writeErr'  as const, error: String(error), replyTo, span }),
        )

      } else if (toolName === kgraphCreateNodeTool.name) {
        const args = JSON.parse(rawArgs) as { label: string; name: string; properties?: Record<string, unknown>; embeddingText?: string; userId?: string }
        const { label, name, embeddingText } = args
        const effectiveUserId = args.userId ?? message.userId
        const now = new Date().toISOString()
        const properties = {
          ...(args.properties
            ? Object.fromEntries(Object.entries(args.properties).filter(([k]) => k === 'description' || k === 'eventTime'))
            : {}),
          createdAt: now,
          updatedAt: now,
        }
        ctx.log.info('kgraph create_node', { label, name, userId: effectiveUserId })
        const span = parent
          ? ctx.trace.child(parent.traceId, parent.spanId, kgraphCreateNodeTool.name, { label, name })
          : null

        if (!embedding || !state.llmRef) {
          replyTo.send({ type: 'toolError', error: 'kgraph_create_node requires embedding to be configured' })
          return { state }
        }

        const llmRef = state.llmRef
        const db = resolveDb(state, effectiveUserId, workPath)

        ctx.pipeToSelf(
          Promise.all(INDEXED_LABELS.map(lbl =>
            db.execute(`CREATE VECTOR INDEX idx_${lbl.toLowerCase()}_embedding ON :${lbl}(_embedding) DIMENSION ${embedding.dimensions} METRIC 'cosine'`).catch(() => {}),
          )).then(() => ask<LlmProviderMsg, EmbeddingReply>(
            llmRef,
            (replyToEmbed) => ({ type: 'embed', requestId: crypto.randomUUID(), model: embedding.model, text: embeddingText ?? name, dimensions: embedding.dimensions, replyTo: replyToEmbed }),
          )).then(async (reply): Promise<CreateNodeResult> => {
            if (reply.type === 'embeddingError') throw new Error(reply.error)
            const vector = reply.embedding

            // Build INSERT query with vector() syntax
            const vectorStr = `vector([${vector.join(',')}])`
            let insertQuery = `INSERT (n:${label} { name: ${JSON.stringify(name)}, _embedding: ${vectorStr}`
            for (const [k, v] of definedEntries(properties)) {
              insertQuery += `, ${k}: ${JSON.stringify(v)}`
            }
            insertQuery += ` }) RETURN n`

            const result = await db.execute(insertQuery)
            const nodes = result.nodes()
            const nodeId = nodes[0]?.id
            if (nodeId === undefined) {
              ctx.log.error('INSERT result rows:', result.toArray())
              throw new Error('INSERT returned no node')
            }
            return { name, nodeId }
          }),
          (result) => ({ type: '_createNodeDone' as const, result, replyTo, span }),
          (error)  => ({ type: '_createNodeErr'  as const, error: String(error), replyTo, span }),
        )

      } else {
        replyTo.send({ type: 'toolError', error: `Unknown tool: ${toolName}` })
      }

      return { state }
    },

    vectorSearch: (state, message, ctx) => {
      const { label, text, topN = 3, userId, replyTo, filter } = message

      if (!embedding || !state?.llmRef) {
        replyTo.send({ type: 'vectorSearchError', error: 'vectorSearch requires embedding to be configured' })
        return { state }
      }

      const llmRef = state.llmRef
      const db = resolveDb(state, userId, workPath)

      const fetchLimit = reranker
        ? (reranker.topK ?? Math.max(topN, 10))
        : topN

      ctx.pipeToSelf(
        Promise.all(INDEXED_LABELS.map(lbl =>
          db.execute(`CREATE VECTOR INDEX idx_${lbl.toLowerCase()}_embedding ON :${lbl}(_embedding) DIMENSION ${embedding.dimensions} METRIC 'cosine'`).catch(() => {}),
        )).then(() => ask<LlmProviderMsg, EmbeddingReply>(
          llmRef,
          (replyToEmbed) => ({ type: 'embed', requestId: crypto.randomUUID(), model: embedding.model, text, dimensions: embedding.dimensions, replyTo: replyToEmbed }),
        ).then(async (reply): Promise<VectorSearchMatch[]> => {
          if (reply.type === 'embeddingError') throw new Error(reply.error)
          const vector = reply.embedding
          const vectorStr = `vector([${vector.join(',')}])`
          
          let whereClause = `WHERE cosine_similarity(n._embedding, ${vectorStr}) > ${cosineSimilarityThreshold}`
          if (filter) {
            if (filter.after) {
              whereClause += ` AND n.${filter.property} >= ${JSON.stringify(filter.after)}`
            }
            if (filter.before) {
              whereClause += ` AND n.${filter.property} <= ${JSON.stringify(filter.before)}`
            }
          }

          // Step 1: Vector search for seeds
          const seedResult = await db.execute(`
            MATCH (n:${label})
            ${whereClause}
            RETURN id(n) AS nodeId, n.name AS name, n.description AS description, cosine_similarity(n._embedding, ${vectorStr}) AS score
            ORDER BY score DESC
            LIMIT ${fetchLimit}
          `)
          const seeds: VectorSearchMatch[] = seedResult.toArray().map((row: any) => ({
           nodeId:      row.nodeId ?? row['id(n)'],
           score:       row.score ?? row['cosine_similarity(n._embedding, ' + vectorStr + ')'],
           name:        row.name ?? '',
           description: row.description ?? '',
          }))

          if (seeds.length === 0) {
           return []
          }

          // Step 2: Rerank (if configured)
          const allMatches = seeds
          if (reranker && allMatches.length > 0) {
           const rerankReply = await ask<LlmProviderMsg, RerankReply>(
             llmRef,
             (replyToRerank) => ({
               type: 'rerank',
               requestId: crypto.randomUUID(),
               model: reranker.model,
               query: text,
               documents: allMatches.map(m => `${m.name}. ${m.description}`),
               topN: allMatches.length,
               replyTo: replyToRerank,
             }),
           )

           if (rerankReply.type === 'rerankError') {
             ctx.log.warn('kgraph rerank failed, using vector scores', { error: rerankReply.error })
           } else {
             const scoreMap = new Map<number, number>()
             for (const r of rerankReply.scores) {
               scoreMap.set(r.index, r.score)
             }
             for (let i = 0; i < allMatches.length; i++) {
               const match = allMatches[i]!
               match.score = scoreMap.get(i) ?? match.score
             }
           }
          }

          // Step 3: Sort and slice
          const ranked = allMatches
           .sort((a, b) => b.score - a.score)
           .slice(0, topN)

          return ranked

        })),
        (matches) => ({ type: '_vectorSearchDone' as const, matches, replyTo }),
        (error)   => ({ type: '_vectorSearchErr'  as const, error: String(error), replyTo }),
      )

      return { state }
    },

    _queryDone: (state, message) => {
      const { rows, replyTo, span } = message
      span?.done({ rowCount: rows.length })
      replyTo.send({ type: 'toolResult', result: { text: JSON.stringify(rows) } })
      return { state }
    },

    _queryErr: (state, message, ctx) => {
      const { error, replyTo, span } = message
      ctx.log.error('kgraph query failed', { error })
      span?.error(error)
      replyTo.send({ type: 'toolError', error })
      return { state }
    },

    _writeDone: (state, message, ctx) => {
      const { matched, replyTo, span } = message
      span?.done({ matched })
      if (matched === 0) {
        ctx.log.warn('kgraph create_link matched 0 rows — likely a missing create_node', {})
        replyTo.send({
          type: 'toolResult',
          result: { text: 'Warning: 0 rows matched — no relationships were written. Every node referenced in MATCH must exist via kgraph_create_node before calling kgraph_create_link. Check that all node names are correct and were previously created.' },
        })
      } else {
        replyTo.send({ type: 'toolResult', result: { text: matched > 0 ? `ok (${matched} rows matched)` : 'ok' } })
      }
      return { state }
    },

    _writeErr: (state, message, ctx) => {
      const { error, replyTo, span } = message
      ctx.log.error('kgraph write failed', { error })
      span?.error(error)
      replyTo.send({ type: 'toolError', error })
      return { state }
    },

    _createNodeDone: (state, message, ctx) => {
      const { result, replyTo, span } = message
      ctx.log.info('kgraph create_node done', { name: result.name, nodeId: result.nodeId })
      span?.done({ nodeId: result.nodeId })
      replyTo.send({ type: 'toolResult', result: { text: JSON.stringify(result) } })
      return { state }
    },

    _createNodeErr: (state, message, ctx) => {
      const { error, replyTo, span } = message
      ctx.log.error('kgraph create_node failed', { error })
      span?.error(error)
      replyTo.send({ type: 'toolError', error })
      return { state }
    },

    updateNode: (state, message, ctx) => {
      const { nodeId, properties, embeddingText, userId, replyTo } = message
      if (nodeId === undefined || nodeId === null || isNaN(nodeId)) {
        replyTo.send({ type: 'toolError', error: `Invalid nodeId: ${nodeId}` })
        return { state }
      }

      const db = resolveDb(state, userId, workPath)

      const applyProperties = async (vec?: number[]) => {
        const setClauses: string[] = []
        if (vec) {
          setClauses.push(`n._embedding = vector([${vec.join(',')}])`)
        }
        for (const [k, v] of definedEntries(properties)) {
          setClauses.push(`n.${k} = ${JSON.stringify(v)}`)
        }
        setClauses.push(`n.updatedAt = ${JSON.stringify(new Date().toISOString())}`)
        if (setClauses.length > 0) {
          await db.execute(`MATCH (n) WHERE id(n) = ${nodeId} SET ${setClauses.join(', ')}`)
        }
      }

      if (embeddingText && embedding && state.llmRef) {
        const llmRef = state.llmRef
        ctx.pipeToSelf(
          ask<LlmProviderMsg, EmbeddingReply>(
            llmRef,
            (replyToEmbed) => ({ type: 'embed', requestId: crypto.randomUUID(), model: embedding.model, text: embeddingText, dimensions: embedding.dimensions, replyTo: replyToEmbed }),
          ).then((reply) => {
            if (reply.type === 'embeddingError') throw new Error(reply.error)
            return applyProperties(reply.embedding)
          }),
          () => ({ type: '_updateNodeDone' as const, replyTo }),
          (error) => ({ type: '_updateNodeErr' as const, error: String(error), replyTo }),
        )
      } else {
        ctx.pipeToSelf(
          applyProperties(),
          () => ({ type: '_updateNodeDone' as const, replyTo }),
          (error) => ({ type: '_updateNodeErr' as const, error: String(error), replyTo }),
        )
      }

      return { state }
    },

    _updateNodeDone: (state, message, ctx) => {
      ctx.log.info('kgraph update_node done', {})
      message.replyTo.send({ type: 'toolResult', result: { text: 'ok' } })
      return { state }
    },

    _updateNodeErr: (state, message, ctx) => {
      ctx.log.error('kgraph update_node failed', { error: message.error })
      message.replyTo.send({ type: 'toolError', error: message.error })
      return { state }
    },

    _vectorSearchDone: (state, message) => {
      message.replyTo.send({ type: 'vectorSearchResult', matches: message.matches })
      return { state }
    },

    _vectorSearchErr: (state, message, ctx) => {
      ctx.log.error('kgraph vectorSearch failed', { error: message.error })
      message.replyTo.send({ type: 'vectorSearchError', error: message.error })
      return { state }
    },

    dump: (state, message, ctx) => {
      const { userId } = message
      const db = resolveDb(state, userId, workPath)

      const nodeQuery = 'MATCH (n) RETURN n'
      const edgeQuery = 'MATCH ()-[r]->() RETURN r'

      ctx.pipeToSelf(
        Promise.all([
          db.execute(nodeQuery),
          db.execute(edgeQuery),
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
