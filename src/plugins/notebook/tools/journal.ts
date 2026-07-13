import type { ActorDef, ActorRef, SpanHandle } from '../../../system/index.ts'
import { onLifecycle, onMessage, ask } from '../../../system/index.ts'
import { defineTool } from '../../../system/index.ts'
import type { ToolInvokeMsg, ToolReply } from '../../../types/tools.ts'
import { NotebookChangeTopic } from '../../../types/events.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult, type PList } from '../../../types/persistence.ts'

export const journalWriteTool = defineTool('journal_write', 'Add an entry to the daily journal.', {
  type: 'object',
  properties: {
    entry: { type: 'string', description: 'The journal entry text (markdown supported).' },
    date:  { type: 'string', description: 'Date in YYYY-MM-DD format (optional).' },
  },
  required: ['entry'],
})

export const journalReadTool = defineTool('journal_read', 'Read the journal entry for a specific date.', {
  type: 'object',
  properties: {
    date: { type: 'string', description: 'Date to read in YYYY-MM-DD format.' },
  },
  required: ['date'],
})

export const journalSearchTool = defineTool('journal_search', 'Search across all journal entries for a given query string.', {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Text to search for (case-insensitive).' },
  },
  required: ['query'],
})

type JournalState = {
  persistenceRef: ActorRef<any> | null
}

type JournalMsg =
  | ToolInvokeMsg
  | { type: '_done';  replyTo: ActorRef<ToolReply>; toolName: string; result: string; span: SpanHandle | null; userId: string; date?: string }
  | { type: '_error'; replyTo: ActorRef<ToolReply>; toolName: string; error: string; span: SpanHandle | null }
  | { type: '_persistenceRef'; ref: ActorRef<any> | null }
  | { type: '_void' }

const todayISO = (): string => new Date().toISOString().slice(0, 10)

const writeEntry = async (persistenceRef: ActorRef<any>, entry: string, date: string): Promise<string> => {
  const time = new Date().toTimeString().slice(0, 5)
  const section = `\n## ${time}\n\n${entry}\n`
  const docId = date.endsWith('.md') ? date : `${date}.md`
  await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
    type: 'doc.append',
    collection: 'journal',
    docId,
    content: section,
    replyTo,
  }))
  return `Journal entry written to journal/${date.replace('.md', '')}.md`
}

export const readEntry = async (persistenceRef: ActorRef<any>, date: string): Promise<string> => {
  const docId = date.endsWith('.md') ? date : `${date}.md`
  const res = await ask<PersistenceMsg, PResult<string>>(persistenceRef, (replyTo) => ({
    type: 'doc.get',
    collection: 'journal',
    docId,
    replyTo,
  }))
  if (res.ok && res.data) return res.data
  return `No journal entry found for ${date.replace('.md', '')}.`
}

const searchJournal = async (persistenceRef: ActorRef<any>, query: string): Promise<string> => {
  const listRes = await ask<PersistenceMsg, PList>(persistenceRef, (replyTo) => ({
    type: 'doc.list',
    collection: 'journal',
    replyTo,
  }))
  if (!listRes.ok || listRes.keys.length === 0) {
    return `No journal entries found.`
  }

  const results: string[] = []
  const lower = query.toLowerCase()

  for (const docId of listRes.keys) {
    const content = await readEntry(persistenceRef, docId)
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line && line.toLowerCase().includes(lower)) {
        results.push(`${docId}:${i + 1}: ${line}`)
      }
    }
  }

  return results.length > 0
    ? results.join('\n')
    : `No results found for "${query}".`
}



export const Journal = (): ActorDef<JournalMsg, JournalState> => ({
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
  handler: onMessage<JournalMsg, JournalState>({
    _persistenceRef: (state, msg) => {
      return { state: { ...state, persistenceRef: msg.ref } }
    },

    _void: (state) => ({ state }),

    invoke: (state, msg, ctx) => {
      if (!state.persistenceRef) {
        msg.replyTo.send({ type: 'toolError', error: 'Persistence not ready' })
        return { state }
      }
      const dl = state.persistenceRef
      let promise: Promise<string>
      let date: string | undefined
      try {
        if (msg.toolName === journalWriteTool.name) {
          const args = JSON.parse(msg.arguments) as { entry: string; date?: string }
          date = args.date ?? todayISO()
          promise = writeEntry(dl, args.entry, date)
        } else if (msg.toolName === journalReadTool.name) {
          const args = JSON.parse(msg.arguments) as { date: string }
          promise = readEntry(dl, args.date)
        } else if (msg.toolName === journalSearchTool.name) {
          const args = JSON.parse(msg.arguments) as { query: string }
          promise = searchJournal(dl, args.query)
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
        (result) => ({ type: '_done'  as const, replyTo: msg.replyTo, toolName: msg.toolName, result, span, userId: msg.userId, date }),
        (error)  => ({ type: '_error' as const, replyTo: msg.replyTo, toolName: msg.toolName, error: String(error), span }),
      )
      return { state }
    },

    _done: (state, msg, ctx) => {
      msg.span?.done()
      msg.replyTo.send({ type: 'toolResult', result: { text: msg.result } })
      if (msg.toolName === journalWriteTool.name && msg.date) {
        ctx.publish(NotebookChangeTopic, { type: 'journalUpdated', userId: msg.userId, date: msg.date })
      }
      return { state }
    },

    _error: (state, msg, ctx) => {
      ctx.log.error('journal error', { tool: msg.toolName, error: msg.error })
      msg.span?.error(msg.error)
      msg.replyTo.send({ type: 'toolError', error: msg.error })
      return { state }
    },
  }),

  supervision: { type: 'restart', maxRetries: 5, withinMs: 60_000 },
})
