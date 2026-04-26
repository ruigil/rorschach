import { mkdir } from 'node:fs/promises'
import type { ActorDef, ActorRef, SpanHandle } from '../../../system/types.ts'
import { onMessage } from '../../../system/match.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from '../../../types/tools.ts'

// ─── Tool names & schemas ───

export const JOURNAL_WRITE_TOOL_NAME  = 'journal_write'
export const JOURNAL_READ_TOOL_NAME   = 'journal_read'
export const JOURNAL_SEARCH_TOOL_NAME = 'journal_search'

export const JOURNAL_WRITE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: JOURNAL_WRITE_TOOL_NAME,
    description: 'Append a new entry to the daily journal. Creates the file if it does not exist.',
    parameters: {
      type: 'object',
      properties: {
        entry: { type: 'string', description: 'The journal entry text (markdown supported).' },
        date:  { type: 'string', description: 'Date to write to in YYYY-MM-DD format. Defaults to today.' },
      },
      required: ['entry'],
    },
  },
}

export const JOURNAL_READ_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: JOURNAL_READ_TOOL_NAME,
    description: 'Read the journal entry for a specific date.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date to read in YYYY-MM-DD format.' },
      },
      required: ['date'],
    },
  },
}

export const JOURNAL_SEARCH_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: JOURNAL_SEARCH_TOOL_NAME,
    description: 'Search across all journal entries for a given query string.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for (case-insensitive).' },
      },
      required: ['query'],
    },
  },
}

// ─── Internal message type ───

type JournalMsg =
  | ToolInvokeMsg
  | { type: '_done';  replyTo: ActorRef<ToolReply>; toolName: string; result: string; span: SpanHandle | null }
  | { type: '_error'; replyTo: ActorRef<ToolReply>; toolName: string; error: string; span: SpanHandle | null }

// ─── Helpers ───

const todayISO = (): string => new Date().toISOString().slice(0, 10)

const journalPath = (notebookDir: string, date: string): string => {
  const [year, month, day] = date.split('-')
  return `${notebookDir}/journal/${year}/${month}/${day}.md`
}

const writeEntry = async (notebookDir: string, entry: string, date: string): Promise<string> => {
  const path = journalPath(notebookDir, date)
  const dir  = path.slice(0, path.lastIndexOf('/'))
  await mkdir(dir, { recursive: true })
  const time     = new Date().toTimeString().slice(0, 5)
  const section  = `\n## ${time}\n\n${entry}\n`
  const existing = await Bun.file(path).text().catch(() => '')
  await Bun.write(path, existing + section)
  return `Journal entry written to ${path}`
}

const readEntry = async (notebookDir: string, date: string): Promise<string> => {
  const path = journalPath(notebookDir, date)
  const file = Bun.file(path)
  if (!(await file.exists())) return `No journal entry found for ${date}.`
  return await file.text()
}

const searchJournal = async (notebookDir: string, query: string): Promise<string> => {
  const journalDir = `${notebookDir}/journal`
  const glob       = new Bun.Glob('**/*.md')
  const results: string[] = []
  const lower = query.toLowerCase()

  for await (const relPath of glob.scan({ cwd: journalDir })) {
    const content = await Bun.file(`${journalDir}/${relPath}`).text().catch(() => '')
    const lines   = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.toLowerCase().includes(lower)) {
        results.push(`${relPath}:${i + 1}: ${lines[i]}`)
      }
    }
  }

  return results.length > 0
    ? results.join('\n')
    : `No results found for "${query}".`
}

// ─── Actor ───

export const createJournalActor = (notebookDir: string): ActorDef<JournalMsg, null> => ({
  handler: onMessage<JournalMsg, null>({
    invoke: (state, msg, ctx) => {
      let promise: Promise<string>
      try {
        const args = JSON.parse(msg.arguments) as Record<string, string>
        if (msg.toolName === JOURNAL_WRITE_TOOL_NAME) {
          ctx.log.info('journal: write', { date: args.date ?? todayISO() })
          promise = writeEntry(notebookDir, args.entry!, args.date ?? todayISO())
        } else if (msg.toolName === JOURNAL_READ_TOOL_NAME) {
          ctx.log.info('journal: read', { date: args.date })
          promise = readEntry(notebookDir, args.date!)
        } else if (msg.toolName === JOURNAL_SEARCH_TOOL_NAME) {
          ctx.log.info('journal: search', { query: args.query })
          promise = searchJournal(notebookDir, args.query!)
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
      msg.replyTo.send({ type: 'toolResult', result: msg.result })
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
