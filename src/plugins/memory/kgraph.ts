import { GrafeoDB } from '@grafeo-db/js'
import type { ActorDef, ActorRef, SpanHandle } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from '../../types/tools.ts'
import type { EmbeddingReply, LlmProviderMsg } from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { KgraphGraph, KgraphMsg, KgraphRefEvent, UpsertResult } from '../../types/memory.ts'
import { KgraphTopic } from '../../types/memory.ts'
import { ask } from '../../system/ask.ts'
import { createNoteAgentActor } from '../notebook/note-agent.ts'
export { KgraphTopic }
export type { KgraphGraph, KgraphMsg, KgraphRefEvent }

// ─── Constants ───

// GrafeoDB vectorSearch returns cosine *distance* (0 = identical, 1 = orthogonal),
// sorted ascending. We merge when distance is below this threshold, which
// corresponds to a cosine similarity of (1 - UPSERT_DISTANCE_THRESHOLD) = 0.88.
const UPSERT_DISTANCE_THRESHOLD = 0.12

// Node labels that get a vector index on startup
const INDEXED_LABELS = ['Entity', 'Project', 'Concept', 'Preference', 'Goal', 'Place', 'Event', 'Habit'] as const

// ─── Tool names & schemas ───

export const KGRAPH_QUERY_TOOL_NAME = 'kgraph_query'

export const KGRAPH_QUERY_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: KGRAPH_QUERY_TOOL_NAME,
    description:
      'This knowledge graph is where you store information about your user. ' +
      'Run a read-only Cypher query against the persistent knowledge graph to retrieve stored facts. ' +
      'Use MATCH/RETURN clauses only. Returns a JSON array of row objects. ' +
      'Example: MATCH (p:Entity {name: "Default"})-[:KNOWS]->(f) RETURN p.name, f.name',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A Cypher MATCH/RETURN query. Must not contain INSERT, MERGE, SET, or DELETE.',
        },
      },
      required: ['query'],
    },
  },
}

export const KGRAPH_WRITE_TOOL_NAME = 'kgraph_write'

export const KGRAPH_WRITE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: KGRAPH_WRITE_TOOL_NAME,
    description:
      'Execute a Cypher write statement to store or update facts in the persistent knowledge graph. ' +
      'Use for relationships (MERGE/SET/DELETE) only — use kgraph_upsert to create or update nodes. ' +
      'Returns "ok" on success. ' +
      'Node constraint: when referencing nodes inline, only "name" and "description" properties are allowed. ' +
      'Example: MERGE (u:Entity {name:"Alice"})-[:LOCATED_IN]->(p:Place {name:"Lisbon"})',
    parameters: {
      type: 'object',
      properties: {
        statement: {
          type: 'string',
          description: 'A Cypher write statement using MERGE, SET, or DELETE for relationships.',
        },
      },
      required: ['statement'],
    },
  },
}

export const KGRAPH_UPSERT_TOOL_NAME = 'kgraph_upsert'

export const KGRAPH_UPSERT_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: KGRAPH_UPSERT_TOOL_NAME,
    description:
      'Create or update a node in the knowledge graph with semantic deduplication. ' +
      'Uses vector similarity to detect existing nodes that represent the same entity, even if named slightly differently. ' +
      'Returns { canonicalName, nodeId, merged } — always use canonicalName (not the name you passed) in subsequent kgraph_write calls. ' +
      'Node constraint: nodes only store "name" and "description". Put all detail in the description; any other properties will be ignored.',
    parameters: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'Node label: Entity | Project | Concept | Preference | Goal | Place | Event | Habit',
        },
        name: {
          type: 'string',
          description: 'The name of the node. Use Title Case words separated by spaces. No CamelCase, no underscores, no abbreviations. Prefer the shortest unambiguous form (e.g. "Lisbon" not "Lisbon Portugal"; "Complexity Science" not "ComplexityScience" or "complexity science").',
        },
        properties: {
          type: 'object',
          description: 'Only "description" is accepted. Include all relevant detail here as a descriptive sentence (e.g. { description: "City in western Portugal, capital of the country." }). Any other keys are ignored.',
          properties: {
            description: {
              type: 'string',
              description: 'A descriptive sentence capturing the important details about this node.',
            },
          },
          additionalProperties: false,
        },
      },
      required: ['label', 'name'],
    },
  },
}

// ─── State ───

export type KgraphState = { db: GrafeoDB; llmRef: ActorRef<LlmProviderMsg> | null } | null

// ─── Actor definition ───

export const createKgraphActor = (
  dbPath: string,
  embedding?: { model: string; dimensions: number },
): ActorDef<KgraphMsg, KgraphState> => ({

  lifecycle: onLifecycle({
    start: async (_state, ctx) => {
      ctx.log.info('kgraph opening database', { path: dbPath })
      const db = GrafeoDB.create(dbPath)

      if (embedding) {
        for (const label of INDEXED_LABELS) {
          try {
            await db.createVectorIndex(label, '_embedding', embedding.dimensions)
            ctx.log.debug('kgraph vector index created', { label })
          } catch {
            ctx.log.debug('kgraph vector index already exists', { label })
          }
        }
        ctx.subscribe(LlmProviderTopic, (e) => ({ type: '_llmProvider' as const, ref: e.ref }))
      }

      ctx.log.info('kgraph database ready')
      return { state: { db, llmRef: null } }
    },

    stopped: async (state, ctx) => {
      if (state?.db) {
        ctx.log.info('kgraph closing database')
        state.db.close()
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

      if (!state?.db) {
        replyTo.send({ type: 'toolError', error: 'kgraph database not ready' })
        return { state }
      }

      const parent = ctx.trace.fromHeaders()

      if (toolName === KGRAPH_QUERY_TOOL_NAME) {
        const args = JSON.parse(rawArgs) as { query: string }
        ctx.log.info('kgraph query', { query: args.query })
        const span = parent
          ? ctx.trace.child(parent.traceId, parent.spanId, KGRAPH_QUERY_TOOL_NAME, { query: args.query })
          : null

        ctx.pipeToSelf(
          state.db.execute(args.query).then(r => r.rows() as unknown[]),
          (rows)  => ({ type: '_queryDone' as const, rows, replyTo, span }),
          (error) => ({ type: '_queryErr'  as const, error: String(error), replyTo, span }),
        )

      } else if (toolName === KGRAPH_WRITE_TOOL_NAME) {
        const args = JSON.parse(rawArgs) as { statement: string }
        ctx.log.info('kgraph write', { statement: args.statement })
        const span = parent
          ? ctx.trace.child(parent.traceId, parent.spanId, KGRAPH_WRITE_TOOL_NAME, { statement: args.statement })
          : null

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
          state.db.executeCypher(query).then(result => {
            if (hasReturn) return -1  // unknown — statement has its own RETURN
            const row = result.toArray()[0] as { _n?: number } | undefined
            return row?._n ?? 0
          }),
          (matched) => ({ type: '_writeDone' as const, matched, replyTo, span }),
          (error)   => ({ type: '_writeErr'  as const, error: String(error), replyTo, span }),
        )

      } else if (toolName === KGRAPH_UPSERT_TOOL_NAME) {
        const args = JSON.parse(rawArgs) as { label: string; name: string; properties?: Record<string, unknown> }
        const { label, name } = args
        const properties = args.properties
          ? Object.fromEntries(Object.entries(args.properties).filter(([k]) => k === 'description'))
          : undefined
        ctx.log.info('kgraph upsert', { label, name })
        const span = parent
          ? ctx.trace.child(parent.traceId, parent.spanId, KGRAPH_UPSERT_TOOL_NAME, { label, name })
          : null

        if (!embedding || !state.llmRef) {
          replyTo.send({ type: 'toolError', error: 'kgraph_upsert requires embedding to be configured' })
          return { state }
        }

        const llmRef = state.llmRef
        const db = state.db

        ctx.pipeToSelf(
          ask<LlmProviderMsg, EmbeddingReply>(
            llmRef,
            (replyToEmbed) => ({ type: 'embed', requestId: crypto.randomUUID(), model: embedding.model, text: name, replyTo: replyToEmbed }),
          ).then(async (reply): Promise<UpsertResult> => {
            if (reply.type === 'embeddingError') throw new Error(reply.error)
            const vector = reply.embedding
            
            const candidates = await db.vectorSearch(label, '_embedding', vector, 5)

            for (const pair of candidates) {
              const nodeId = pair[0] as number
              const score  = pair[1] as number
              if (score > UPSERT_DISTANCE_THRESHOLD) break  // sorted ascending by distance
              const node = db.getNode(nodeId)
              if (!node) continue
              const canonicalName = node.get('name') as string
              for (const [k, v] of Object.entries(properties ?? {})) {
                db.setNodeProperty(nodeId, k, v)
              }
              return { canonicalName, nodeId, merged: true }
            }

            // batchCreateNodes is required (not createNode) so the node is registered
            // in the HNSW vector index and discoverable by future vectorSearch calls.
            const ids = await db.batchCreateNodes(label, '_embedding', [vector])
            const nodeId = ids[0]
            if (nodeId === undefined) throw new Error('batchCreateNodes returned no id')
            db.setNodeProperty(nodeId, 'name', name)
            for (const [k, v] of Object.entries(properties ?? {})) {
              db.setNodeProperty(nodeId, k, v)
            }
            return { canonicalName: name, nodeId, merged: false }
          }),
          (result) => ({ type: '_upsertDone' as const, result, replyTo, span }),
          (error)  => ({ type: '_upsertErr'  as const, error: String(error), replyTo, span }),
        )

      } else {
        replyTo.send({ type: 'toolError', error: `Unknown tool: ${toolName}` })
      }

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
        ctx.log.warn('kgraph write matched 0 rows — likely a missing upsert', {})
        replyTo.send({
          type: 'toolResult',
          result: 'Warning: 0 rows matched — no relationships were written. Every node referenced in MATCH must exist via kgraph_upsert before calling kgraph_write. Check that all node names are correct and were previously upserted.',
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

    _upsertDone: (state, message, ctx) => {
      const { result, replyTo, span } = message
      ctx.log.info('kgraph upsert done', { canonicalName: result.canonicalName, merged: result.merged })
      span?.done({ merged: result.merged })
      replyTo.send({ type: 'toolResult', result: JSON.stringify(result) })
      return { state }
    },

    _upsertErr: (state, message, ctx) => {
      const { error, replyTo, span } = message
      ctx.log.error('kgraph upsert failed', { error })
      span?.error(error)
      replyTo.send({ type: 'toolError', error })
      return { state }
    },

    dump: (state, message, ctx) => {
      if (!state?.db) {
        message.replyTo.send({ nodes: [], edges: [] })
        return { state }
      }

      const { userId } = message
      // GrafeoDB [*0..] excludes the start node, so we use OPTIONAL MATCH + *1..
      // to include the root itself, and UNION to collect both root-direct and
      // descendant edges in one pass.
      const nodeQuery = userId
        ? `MATCH (u:Entity {name: ${JSON.stringify(userId)}}) OPTIONAL MATCH (u)-[*1..]->(n) RETURN DISTINCT u, n`
        : 'MATCH (n) RETURN n'
      const edgeQuery = userId
        ? `MATCH (u:Entity {name: ${JSON.stringify(userId)}})-[r]->() RETURN DISTINCT r
           UNION
           MATCH (u:Entity {name: ${JSON.stringify(userId)}})-[*1..]->(a)-[r]->(b) RETURN DISTINCT r`
        : 'MATCH ()-[r]->() RETURN r'

      ctx.pipeToSelf(
        Promise.all([
          state.db.execute(nodeQuery),
          state.db.execute(edgeQuery),
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
