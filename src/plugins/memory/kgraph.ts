import { GrafeoDB } from '@grafeo-db/js'
import type { ActorDef, ActorRef, SpanHandle } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from '../../types/tools.ts'
import type { KgraphGraph, KgraphMsg, KgraphRefEvent } from '../../types/memory.ts'
import { KgraphTopic } from '../../types/memory.ts'
export { KgraphTopic }
export type { KgraphGraph, KgraphMsg, KgraphRefEvent }

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
      'Example: MATCH (p:Person {name: "Alice"})-[:KNOWS]->(f) RETURN p.name, f.name',
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
      'Supports INSERT, MERGE, SET, and DELETE. Returns "ok" on success. ' +
      'Example: INSERT (:Person {name: "Alice", age: 30})',
    parameters: {
      type: 'object',
      properties: {
        statement: {
          type: 'string',
          description: 'A Cypher write statement using INSERT, MERGE, SET, or DELETE.',
        },
      },
      required: ['statement'],
    },
  },
}

// ─── Message protocol ───

export type KgraphState = { db: GrafeoDB } | null

// ─── Actor definition ───

export const createKgraphActor = (dbPath: string): ActorDef<KgraphMsg, KgraphState> => ({

  lifecycle: onLifecycle({
    start: async (_state, ctx) => {
      ctx.log.info('kgraph opening database', { path: dbPath })
      const db = await GrafeoDB.create(dbPath)
      ctx.log.info('kgraph database ready')
      return { state: { db } }
    },

    stopped: async (state, ctx) => {
      if (state?.db) {
        ctx.log.info('kgraph closing database')
        await state.db.close()
      }
      return { state }
    },
  }),

  handler: onMessage<KgraphMsg, KgraphState>({
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

        ctx.pipeToSelf(
          state.db.execute(args.statement).then(() => undefined),
          ()      => ({ type: '_writeDone' as const, replyTo, span }),
          (error) => ({ type: '_writeErr'  as const, error: String(error), replyTo, span }),
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

    _writeDone: (state, message) => {
      const { replyTo, span } = message
      span?.done()
      replyTo.send({ type: 'toolResult', result: 'ok' })
      return { state }
    },

    dump: (state, message, ctx) => {
      if (!state?.db) {
        message.replyTo.send({ nodes: [], edges: [] })
        return { state }
      }

      ctx.pipeToSelf(
        Promise.all([
          state.db.execute('MATCH (n) RETURN n'),
          state.db.execute('MATCH ()-[r]->() RETURN r'),
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

    _writeErr: (state, message, ctx) => {
      const { error, replyTo, span } = message
      ctx.log.error('kgraph write failed', { error })
      span?.error(error)
      replyTo.send({ type: 'toolError', error })
      return { state }
    },
  }),

  supervision: { type: 'restart', maxRetries: 3, withinMs: 60_000, backoffMs: 500, maxBackoffMs: 8_000 },
})
