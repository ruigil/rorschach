import { GrafeoDB } from '@grafeo-db/js'
import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import type { ToolSchema } from '../../types/tools.ts'
import type { EmbeddingReply, LlmProviderMsg } from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { KgraphGraph, KgraphMsg, KgraphRefEvent, CreateNodeResult, VectorSearchMatch } from '../../types/memory.ts'
import { KgraphTopic } from '../../types/memory.ts'
import { ask } from '../../system/ask.ts'
export { KgraphTopic }
export type { KgraphGraph, KgraphMsg, KgraphRefEvent }

// ─── Constants ───

// Node labels that get a vector index on startup
const INDEXED_LABELS = ['Note'] as const

// ─── Tool names & schemas ───

export const KGRAPH_QUERY_TOOL_NAME = 'kgraph_query'

export const KGRAPH_QUERY_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: KGRAPH_QUERY_TOOL_NAME,
    description:
      'Run a read-only Cypher query against the persistent knowledge graph. ' +
      'Use MATCH/RETURN clauses only. Returns a JSON array of row objects. ' +
      'Example: MATCH (n:Note {name: "Bun Runtime"}) RETURN n.name, n.description',
    parameters: {
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
    },
  },
}

export const KGRAPH_CREATE_LINK_TOOL_NAME = 'kgraph_create_link'

export const KGRAPH_CREATE_LINK_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: KGRAPH_CREATE_LINK_TOOL_NAME,
    description:
      'Execute a Cypher write statement to store or update relationships in the knowledge graph. ' +
      'Use for relationships (MERGE/SET/DELETE) only — use kgraph_create_node to create nodes. ' +
      'Returns "ok" on success. ' +
      'Node constraint: when referencing nodes inline, only "name" and "description" properties are allowed. ' +
      'Example: MERGE (a:Note {name:"Bun Runtime"})-[:LINKS_TO]->(b:Note {name:"TypeScript Preferences"})',
    parameters: {
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
    },
  },
}

export const KGRAPH_CREATE_NODE_TOOL_NAME = 'kgraph_create_node'

export const KGRAPH_CREATE_NODE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: KGRAPH_CREATE_NODE_TOOL_NAME,
    description:
      'Create a new node in the knowledge graph. ' +
      'Returns { name, nodeId }. Use nodeId in subsequent kgraph_create_link calls. ' +
      'Node constraint: nodes only store "name" and "description". Put all detail in the description; any other properties will be ignored.',
    parameters: {
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
          description: 'Only "description" is accepted. For notes, use format "noteId:{uuid}\\n{synopsis}".',
          properties: {
            description: { type: 'string' },
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
    },
  },
}

// ─── State ───

export type KgraphState = {
  userDbs: Map<string, GrafeoDB>
  llmRef: ActorRef<LlmProviderMsg> | null
} | null

// ─── Helpers ───

const resolveDb = (state: NonNullable<KgraphState>, userId: string, basePath: string): GrafeoDB => {
  const existing = state.userDbs.get(userId)
  if (existing) return existing
  const userDbPath = `${basePath}/${userId}/kgraph`
  const db = GrafeoDB.create(userDbPath)
  state.userDbs.set(userId, db)
  return db
}

// ─── Actor definition ───

export const createKgraphActor = (
  basePath: string,
  embedding?: { model: string; dimensions: number },
): ActorDef<KgraphMsg, KgraphState> => ({

  lifecycle: onLifecycle({
    start: async (_state, ctx) => {
      if (embedding) {
        ctx.subscribe(LlmProviderTopic, (e) => ({ type: '_llmProvider' as const, ref: e.ref }))
      }

      ctx.log.info('kgraph ready (user-isolated mode)', { basePath })
      return { state: { userDbs: new Map(), llmRef: null } }
    },

    stopped: async (state, ctx) => {
      if (state) {
        ctx.log.info('kgraph closing databases')
        const dbs = Array.from(state.userDbs.values())
        for (const db of dbs) db.close()
      }
      return { state }
    },
  }),

  handler: onMessage<KgraphMsg, KgraphState>({
    _llmProvider: (state, msg) => ({
      state: state ? { ...state, llmRef: msg.ref } : null,
    }),

    invoke: (state, message, ctx) => {
      const { toolName, arguments: rawArgs, replyTo } = message

      if (!state) {
        replyTo.send({ type: 'toolError', error: 'kgraph database not ready' })
        return { state }
      }

      const parent = ctx.trace.fromHeaders()

      if (toolName === KGRAPH_QUERY_TOOL_NAME) {
        const args = JSON.parse(rawArgs) as { query: string; userId?: string }
        const effectiveUserId = args.userId ?? message.userId
        ctx.log.info('kgraph query', { query: args.query, userId: effectiveUserId })
        const span = parent
          ? ctx.trace.child(parent.traceId, parent.spanId, KGRAPH_QUERY_TOOL_NAME, { query: args.query })
          : null
        const db = resolveDb(state, effectiveUserId, basePath)

        ctx.pipeToSelf(
          db.execute(args.query).then(r => r.rows() as unknown[]),
          (rows)  => ({ type: '_queryDone' as const, rows, replyTo, span }),
          (error) => ({ type: '_queryErr'  as const, error: String(error), replyTo, span }),
        )

      } else if (toolName === KGRAPH_CREATE_LINK_TOOL_NAME) {
        const args = JSON.parse(rawArgs) as { statement: string; userId?: string }
        const effectiveUserId = args.userId ?? message.userId
        ctx.log.info('kgraph create_link', { statement: args.statement, userId: effectiveUserId })
        const span = parent
          ? ctx.trace.child(parent.traceId, parent.spanId, KGRAPH_CREATE_LINK_TOOL_NAME, { statement: args.statement })
          : null
        const db = resolveDb(state, effectiveUserId, basePath)

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
          db.executeCypher(query).then(result => {
            if (hasReturn) return -1  // unknown — statement has its own RETURN
            const row = result.toArray()[0] as { _n?: number } | undefined
            return row?._n ?? 0
          }),
          (matched) => ({ type: '_writeDone' as const, matched, replyTo, span }),
          (error)   => ({ type: '_writeErr'  as const, error: String(error), replyTo, span }),
        )

      } else if (toolName === KGRAPH_CREATE_NODE_TOOL_NAME) {
        const args = JSON.parse(rawArgs) as { label: string; name: string; properties?: Record<string, unknown>; embeddingText?: string; userId?: string }
        const { label, name, embeddingText } = args
        const effectiveUserId = args.userId ?? message.userId
        const properties = args.properties
          ? Object.fromEntries(Object.entries(args.properties).filter(([k]) => k === 'description'))
          : undefined
        ctx.log.info('kgraph create_node', { label, name, userId: effectiveUserId })
        const span = parent
          ? ctx.trace.child(parent.traceId, parent.spanId, KGRAPH_CREATE_NODE_TOOL_NAME, { label, name })
          : null

        if (!embedding || !state.llmRef) {
          replyTo.send({ type: 'toolError', error: 'kgraph_create_node requires embedding to be configured' })
          return { state }
        }

        const llmRef = state.llmRef
        const db = resolveDb(state, effectiveUserId, basePath)

        ctx.pipeToSelf(
          Promise.all(INDEXED_LABELS.map(lbl =>
            db.createVectorIndex(lbl, '_embedding', embedding.dimensions).catch(() => {}),
          )).then(() => ask<LlmProviderMsg, EmbeddingReply>(
            llmRef,
            (replyToEmbed) => ({ type: 'embed', requestId: crypto.randomUUID(), model: embedding.model, text: embeddingText ?? name, dimensions: embedding.dimensions, replyTo: replyToEmbed }),
          )).then(async (reply): Promise<CreateNodeResult> => {
            if (reply.type === 'embeddingError') throw new Error(reply.error)
            const vector = reply.embedding
            const ids = await db.batchCreateNodes(label, '_embedding', [vector])
            const nodeId = ids[0]
            if (nodeId === undefined) throw new Error('batchCreateNodes returned no id')
            db.setNodeProperty(nodeId, 'name', name)
            for (const [k, v] of Object.entries(properties ?? {})) {
              db.setNodeProperty(nodeId, k, v)
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
      const { label, text, topN = 5, userId, replyTo } = message

      if (!embedding || !state?.llmRef) {
        replyTo.send({ type: 'vectorSearchError', error: 'vectorSearch requires embedding to be configured' })
        return { state }
      }

      const llmRef = state.llmRef
      const db = resolveDb(state, userId, basePath)

      ctx.pipeToSelf(
        Promise.all(INDEXED_LABELS.map(lbl =>
          db.createVectorIndex(lbl, '_embedding', embedding.dimensions).catch(() => {}),
        )).then(() => ask<LlmProviderMsg, EmbeddingReply>(
          llmRef,
          (replyToEmbed) => ({ type: 'embed', requestId: crypto.randomUUID(), model: embedding.model, text, dimensions: embedding.dimensions, replyTo: replyToEmbed }),
        ).then(async (reply): Promise<VectorSearchMatch[]> => {
          if (reply.type === 'embeddingError') throw new Error(reply.error)
          const vector = reply.embedding
          const candidates = await db.vectorSearch(label, '_embedding', vector, topN)
          return candidates.map((pair) => {
            const nodeId = pair[0] as number
            const distance = pair[1] as number
            const node = db.getNode(nodeId)
            return {
              nodeId,
              distance,
              name:        (node?.get('name')        as string) ?? '',
              description: (node?.get('description') as string) ?? '',
            }
          })
        })),
        (matches) => ({ type: '_vectorSearchDone' as const, matches, replyTo }),
        (error)   => ({ type: '_vectorSearchErr'  as const, error: String(error), replyTo }),
      )

      return { state }
    },

    _queryDone: (state, message) => {
      const { rows, replyTo, span } = message
      span?.done({ rowCount: rows.length })
      replyTo.send({ type: 'toolResult', result: JSON.stringify(rows) })
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
          result: 'Warning: 0 rows matched — no relationships were written. Every node referenced in MATCH must exist via kgraph_create_node before calling kgraph_create_link. Check that all node names are correct and were previously created.',
        })
      } else {
        replyTo.send({ type: 'toolResult', result: matched > 0 ? `ok (${matched} rows matched)` : 'ok' })
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
      replyTo.send({ type: 'toolResult', result: JSON.stringify(result) })
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

      if (!state) {
        replyTo.send({ type: 'toolError', error: 'kgraph database not ready' })
        return { state }
      }

      const db = resolveDb(state, userId, basePath)

      const applyProperties = (vec?: number[]) => {
        if (vec) db.setNodeProperty(nodeId, '_embedding', vec)
        for (const [k, v] of Object.entries(properties)) {
          db.setNodeProperty(nodeId, k, v)
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
            applyProperties(reply.embedding)
          }),
          () => ({ type: '_updateNodeDone' as const, replyTo }),
          (error) => ({ type: '_updateNodeErr' as const, error: String(error), replyTo }),
        )
      } else {
        try {
          applyProperties()
          replyTo.send({ type: 'toolResult', result: 'ok' })
        } catch (e) {
          replyTo.send({ type: 'toolError', error: String(e) })
        }
      }

      return { state }
    },

    _updateNodeDone: (state, message, ctx) => {
      ctx.log.info('kgraph update_node done', {})
      message.replyTo.send({ type: 'toolResult', result: 'ok' })
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
      if (!state) {
        message.replyTo.send({ nodes: [], edges: [] })
        return { state }
      }

      const { userId } = message
      const db = resolveDb(state, userId, basePath)

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
