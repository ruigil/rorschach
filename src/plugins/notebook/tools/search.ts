import type { ActorDef, ActorRef } from '../../../system/types.ts'
import { onMessage } from '../../../system/match.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from '../../../types/tools.ts'
import type { Todo } from '../types.ts'

// ─── Tool name & schema ───

export const NOTEBOOK_SEARCH_TOOL_NAME = 'notebook_search'

export const NOTEBOOK_SEARCH_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: NOTEBOOK_SEARCH_TOOL_NAME,
    description: 'Full-text search across all notebook content: journal entries, notes, and todo text.',
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

type SearchMsg =
  | ToolInvokeMsg
  | { type: '_done';  replyTo: ActorRef<ToolReply>; toolName: string; result: string }
  | { type: '_error'; replyTo: ActorRef<ToolReply>; toolName: string; error: string }

// ─── Search implementation ───

const searchAll = async (notebookDir: string, query: string): Promise<string> => {
  const lower   = query.toLowerCase()
  const results: string[] = []

  // Search journal files
  const journalDir = `${notebookDir}/journal`
  const journalGlob = new Bun.Glob('**/*.md')
  try {
    for await (const relPath of journalGlob.scan({ cwd: journalDir })) {
      const content = await Bun.file(`${journalDir}/${relPath}`).text().catch(() => '')
      const lines   = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.toLowerCase().includes(lower)) {
          results.push(`journal/${relPath}:${i + 1}: ${lines[i]!.trim()}`)
        }
      }
    }
  } catch {
    // journal dir may not exist yet
  }

  // Search notes files
  const notesDir = `${notebookDir}/notes`
  const notesGlob = new Bun.Glob('*.md')
  try {
    for await (const relPath of notesGlob.scan({ cwd: notesDir })) {
      const content = await Bun.file(`${notesDir}/${relPath}`).text().catch(() => '')
      const lines   = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.toLowerCase().includes(lower)) {
          results.push(`notes/${relPath}:${i + 1}: ${lines[i]!.trim()}`)
        }
      }
    }
  } catch {
    // notes dir may not exist yet
  }

  // Search todos
  try {
    const todosFile = Bun.file(`${notebookDir}/todos.json`)
    if (await todosFile.exists()) {
      const data: { todos: Todo[] } = JSON.parse(await todosFile.text())
      for (const todo of data.todos) {
        if (todo.text.toLowerCase().includes(lower)) {
          results.push(`todos.json: [${todo.id.slice(0, 8)}] ${todo.text}`)
        }
      }
    }
  } catch {
    // ignore
  }

  return results.length > 0
    ? `Found ${results.length} match(es) for "${query}":\n\n${results.join('\n')}`
    : `No results found for "${query}".`
}

// ─── Actor ───

export const createSearchActor = (notebookDir: string): ActorDef<SearchMsg, null> => ({
  handler: onMessage<SearchMsg, null>({
    invoke: (state, msg, ctx) => {
      let promise: Promise<string>
      try {
        const args = JSON.parse(msg.arguments) as Record<string, string>
        if (msg.toolName === NOTEBOOK_SEARCH_TOOL_NAME) {
          ctx.log.info('notebook-search', { query: args.query })
          promise = searchAll(notebookDir, args.query!)
        } else {
          promise = Promise.reject(new Error(`Unknown tool: ${msg.toolName}`))
        }
      } catch (e) {
        promise = Promise.reject(e)
      }
      ctx.pipeToSelf(
        promise,
        (result) => ({ type: '_done'  as const, replyTo: msg.replyTo, toolName: msg.toolName, result }),
        (error)  => ({ type: '_error' as const, replyTo: msg.replyTo, toolName: msg.toolName, error: String(error) }),
      )
      return { state }
    },

    _done: (state, msg) => {
      msg.replyTo.send({ type: 'toolResult', result: msg.result })
      return { state }
    },

    _error: (state, msg, ctx) => {
      ctx.log.error('notebook-search error', { tool: msg.toolName, error: msg.error })
      msg.replyTo.send({ type: 'toolError', error: msg.error })
      return { state }
    },
  }),

  supervision: { type: 'restart', maxRetries: 5, withinMs: 60_000 },
})
