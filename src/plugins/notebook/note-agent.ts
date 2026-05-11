import type { ActorDef } from '../../system/types.ts'
import { onLifecycle } from '../../system/match.ts'
import { createReactLoop, initialReactLoopSlice, type ReactLoopSlice } from '../../system/react-loop.ts'
import type { ToolCollection } from '../../types/tools.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { NoteAgentMsg } from './types.ts'

// ─── Options ───

export type NoteAgentOptions = {
  model:        string
  notebookDir:  string
  maxToolLoops: number
  tools:        ToolCollection
}

// ─── State ───

export type NoteAgentState = {
  loop: ReactLoopSlice
}

// ─── Helpers ───

const todayISO = (): string => new Date().toISOString().slice(0, 10)

const buildSystemPrompt = (notebookDir: string): string =>
  `You are a notebook agent. Today is ${todayISO()}.\n` +
  `You manage a personal notebook stored at "${notebookDir}".\n\n` +
  `Available areas:\n` +
  `- Journal: daily markdown entries (journal_write, journal_read, journal_search)\n` +
  `- Notes: tagged notes with [[wiki-links]] (notes_create, notes_update, notes_read, notes_list, notes_search, notes_attach_file)\n` +
  `- Tracker: habit logging and statistics in CSV (tracker_log, tracker_stats, tracker_define_habit, tracker_list_habits)\n` +
  `- Todos: task list with due dates and recurrence (todos_create, todos_complete, todos_list, todos_delete, todos_update)\n` +
  `- Search: cross-content full-text search (notebook_search)\n\n` +
  `IMPORTANT — file paths and URLs:\n` +
  `- Files are passed to you as absolute filesystem paths.\n` +
  `- Use notes_attach_file to attach them; it creates stable /notebook/attachments/<id> URLs automatically.\n` +
  `- Never write absolute filesystem paths into note content or replies. Preserve /notebook/attachments/<id> links returned by notes_read.\n\n` +
  `IMPORTANT — reading notes:\n` +
  `- When the user's request is to read, show, or open a note, reply only with the note content and attachment links for that note.\n` +
  `- Do not summarize, preface, confirm, mention tool use, or add commentary. Omit administrative metadata like Tags and Created unless it is part of the note body.\n\n` +
  `Use the appropriate tools to fulfill the user's request. Reply with a concise summary of what you did.`

// ─── Actor ───

export const createNoteAgentActor = (options: NoteAgentOptions): ActorDef<NoteAgentMsg, NoteAgentState> => {
  const systemPrompt = buildSystemPrompt(options.notebookDir)

  const handlers = createReactLoop<NoteAgentState, NoteAgentMsg>({
    role:         'notebook',
    spanName:     'note-agent',
    logPrefix:    'note-agent',
    model:        options.model,
    maxToolLoops: options.maxToolLoops,
    tools:        options.tools,

    slice:    (s) => s.loop,
    setSlice: (s, loop) => ({ ...s, loop }),

    buildTurn: (_s, msg) => {
      let request: string
      try {
        const args = JSON.parse(msg.arguments) as { request?: string }
        request = args.request ?? msg.arguments
      } catch {
        return { error: 'Invalid arguments: expected { request: string }' }
      }
      return {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: request },
        ],
      }
    },

    onComplete: (state, finalText) => {
      state.loop.turn.replyTo?.send({ type: 'toolResult', result: { text: finalText || '(done)' } })
      return { state }
    },

    onLlmError: (state) => {
      state.loop.turn.replyTo?.send({ type: 'toolError', error: 'Notebook agent encountered an LLM error.' })
      return { state }
    },

    onLoopLimit: (state) => {
      state.loop.turn.replyTo?.send({ type: 'toolError', error: 'Tool loop limit reached.' })
      return { state }
    },
  })

  return {
    initialState: () => ({ loop: initialReactLoopSlice() }),
    lifecycle: onLifecycle({
      start: (state, context) => {
        context.subscribe(LlmProviderTopic, (e) => ({ type: '_llmProvider' as const, ref: e.ref }))
        return { state }
      },
    }),

    handler: handlers.idle,

    stashCapacity: 50,
    supervision:   { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
