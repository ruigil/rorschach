import type { ActorDef, ActorRef, SpanHandle } from '../../../system/index.ts'
import { onLifecycle, onMessage } from '../../../system/index.ts'
import { defineTool } from '../../../system/index.ts'
import type { ToolInvokeMsg, ToolReply } from '../../../types/tools.ts'
import type { Todo } from '../types.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult, type PList } from '../../../types/persistence.ts'
import { ask } from '../../../system/actor/ask.ts'

export const notebookSearchTool = defineTool('notebook_search', 'Full-text search across journal entries and todo text.', {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Text to search for (case-insensitive).' },
  },
  required: ['query'],
})

type SearchState = {
  persistenceRef: ActorRef<any> | null
}

type SearchMsg =
  | ToolInvokeMsg
  | { type: '_done';  replyTo: ActorRef<ToolReply>; toolName: string; result: string; span: SpanHandle | null }
  | { type: '_error'; replyTo: ActorRef<ToolReply>; toolName: string; error: string; span: SpanHandle | null }
  | { type: '_persistenceRef'; ref: ActorRef<any> | null }
  | { type: '_void' }

const searchAll = async (persistenceRef: ActorRef<any>, query: string): Promise<string> => {
  const lower = query.toLowerCase()
  const results: string[] = []

  // Search journal files
  const listRes = await ask<PersistenceMsg, PList>(persistenceRef, (replyTo) => ({
    type: 'doc.list',
    collection: 'journal',
    replyTo,
  }))
  if (listRes.ok) {
    for (const docId of listRes.keys) {
      const getRes = await ask<PersistenceMsg, PResult<string>>(persistenceRef, (replyTo) => ({
        type: 'doc.get',
        collection: 'journal',
        docId,
        replyTo,
      }))
      if (getRes.ok && getRes.data) {
        const lines = getRes.data.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          if (line && line.toLowerCase().includes(lower)) {
            results.push(`journal/${docId}:${i + 1}: ${line.trim()}`)
          }
        }
      }
    }
  }

  // Search todos
  const todosRes = await ask<PersistenceMsg, PResult<string>>(persistenceRef, (replyTo) => ({
    type: 'doc.get',
    collection: 'notebook',
    docId: 'todos.json',
    replyTo,
  }))
  if (todosRes.ok && todosRes.data) {
    try {
      const data: { todos: Todo[] } = JSON.parse(todosRes.data)
      for (const todo of data.todos) {
        if (todo.text.toLowerCase().includes(lower)) {
          results.push(`todos.json: [${todo.id.slice(0, 8)}] ${todo.text}`)
        }
      }
    } catch {
      // ignore
    }
  }

  return results.length > 0
    ? `Found ${results.length} match(es) for "${query}":\n\n${results.join('\n')}`
    : `No results found for "${query}".`
}



export const Search = (): ActorDef<SearchMsg, SearchState> => ({
  initialState: () => ({ persistenceRef: null }),
  lifecycle: onLifecycle({
    start: (state, context) => {
      context.subscribe(PersistenceProviderTopic, (event) => ({
        type: '_persistenceRef' as const,
        ref: event.ref,
      }))
      return { state }
    }
  }),
  handler: onMessage<SearchMsg, SearchState>({
    _persistenceRef: (state, msg) => {
      return { state: { ...state, persistenceRef: msg.ref } }
    },

    _void: (state) => ({ state }),

    invoke: (state, msg, ctx) => {
      if (!state.persistenceRef) {
        msg.replyTo.send({ type: 'toolError', error: 'Persistence not ready' })
        return { state }
      }
      let promise: Promise<string>
      try {
        if (msg.toolName === notebookSearchTool.name) {
          const args = JSON.parse(msg.arguments) as { query: string }
          promise = searchAll(state.persistenceRef, args.query)
        } else {
          promise = Promise.reject(new Error(`Unknown tool: ${msg.toolName}`))
        }
      } catch (e) {
        promise = Promise.reject(e)
      }
      const parent = ctx.trace.fromHeaders()
      const span: SpanHandle | null = parent
        ? ctx.trace.child(parent.traceId, parent.spanId, msg.toolName, { toolName: msg.toolName })
        : null
      ctx.pipeToSelf(
        promise,
        (result) => ({ type: '_done'  as const, replyTo: msg.replyTo, toolName: msg.toolName, result, span }),
        (error)  => ({ type: '_error' as const, replyTo: msg.replyTo, toolName: msg.toolName, error: String(error), span }),
      )
      return { state }
    },

    _done: (state, msg) => {
      msg.span?.done()
      msg.replyTo.send({ type: 'toolResult', result: { text: msg.result } })
      return { state }
    },

    _error: (state, msg, ctx) => {
      ctx.log.error('notebook-search error', { tool: msg.toolName, error: msg.error })
      msg.span?.error(msg.error)
      msg.replyTo.send({ type: 'toolError', error: msg.error })
      return { state }
    },
  }),

  supervision: { type: 'restart', maxRetries: 5, withinMs: 60_000 },
})
