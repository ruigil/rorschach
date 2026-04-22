import type { ActorContext, ActorRef, PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import type { ToolCollection, ToolInvokeMsg, ToolSchema } from '../../types/tools.ts'
import { ToolRegistrationTopic } from '../../types/tools.ts'

import type { NotebookConfig, NoteAgentMsg, TodoReminderMsg } from './types.ts'

import { createJournalActor, JOURNAL_WRITE_TOOL_NAME, JOURNAL_WRITE_SCHEMA, JOURNAL_READ_TOOL_NAME, JOURNAL_READ_SCHEMA, JOURNAL_SEARCH_TOOL_NAME, JOURNAL_SEARCH_SCHEMA } from './tools/journal.ts'
import { createNotesActor, NOTES_CREATE_TOOL_NAME, NOTES_CREATE_SCHEMA, NOTES_UPDATE_TOOL_NAME, NOTES_UPDATE_SCHEMA, NOTES_READ_TOOL_NAME, NOTES_READ_SCHEMA, NOTES_LIST_TOOL_NAME, NOTES_LIST_SCHEMA, NOTES_SEARCH_TOOL_NAME, NOTES_SEARCH_SCHEMA, NOTES_ATTACH_FILE_TOOL_NAME, NOTES_ATTACH_FILE_SCHEMA, NOTES_DELETE_TOOL_NAME, NOTES_DELETE_SCHEMA } from './tools/notes.ts'
import { createTrackerActor, TRACKER_LOG_TOOL_NAME, TRACKER_LOG_SCHEMA, TRACKER_STATS_TOOL_NAME, TRACKER_STATS_SCHEMA, TRACKER_DEFINE_HABIT_TOOL_NAME, TRACKER_DEFINE_HABIT_SCHEMA, TRACKER_LIST_HABITS_TOOL_NAME, TRACKER_LIST_HABITS_SCHEMA } from './tools/tracker.ts'
import { createTodosActor, TODOS_CREATE_TOOL_NAME, TODOS_CREATE_SCHEMA, TODOS_COMPLETE_TOOL_NAME, TODOS_COMPLETE_SCHEMA, TODOS_LIST_TOOL_NAME, TODOS_LIST_SCHEMA, TODOS_DELETE_TOOL_NAME, TODOS_DELETE_SCHEMA, TODOS_UPDATE_TOOL_NAME, TODOS_UPDATE_SCHEMA } from './tools/todos.ts'
import { createSearchActor, NOTEBOOK_SEARCH_TOOL_NAME, NOTEBOOK_SEARCH_SCHEMA } from './tools/search.ts'
import { createNoteAgentActor, createInitialNoteAgentState } from './note-agent.ts'
import { createTodoReminderActor, INITIAL_TODO_REMINDER_STATE } from './todo-reminder.ts'

// ─── Public tool schema ───

export const NOTE_TOOL_NAME = 'note'

export const NOTE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: NOTE_TOOL_NAME,
    description: `Interact with your personal notebook via a natural language request. A sub-agent handles the request and returns a summary of what was done.
  
This tool is for the user only — only call it when explicitly asked by the user. Never use it to take notes for yourself.

The notebook has four areas — use the request field to describe exactly what you want:

**Journal** — daily markdown diary entries:
- "Write a journal entry: had a productive morning, finished the auth PR"
- "Read my journal entry for 2025-11-03"
- "Search the journal for mentions of 'deployment'"

**Notes** — tagged notes with [[wiki-links]] between them:
- "Create a note titled 'Project Alpha' with content '...' and tags work, alpha"
- "Update the note titled 'Project Alpha', append a new section about the API changes"
- "Read the note titled 'Meeting Notes'"
- "List all notes tagged 'work'"
- "Search notes for 'authentication'"
- "Attach the file /tmp/diagram.png to the note titled 'Architecture'" — attaches a file (image or PDF) to an existing note; the file must exist at an absolute path
- "Delete the note titled 'Old Draft'" — permanently removes the note

**Tracker** — CSV-based logging for habits, expenses, or any numeric metric:
- "Define a new tracker called 'Expenses' with unit 'EUR' or 'CHF'"
- "Define a new habit called 'Exercise' with unit 'minutes'"
- "List all tracked metrics"
- "Log 30 minutes of Exercise for today"
- "Log 45 EUR for Expenses today — lunch"
- "Show my Expenses stats" — includes weekly and monthly totals

**Todos** — task list with due dates and optional recurrence:
- "Create a todo: call dentist, due Friday"
- "List all open todos"
- "List todos due today"
- "Mark the todo 'call dentist' as complete"
- "Delete the todo 'old task'"
- "Update the todo 'call dentist': change due date to next Monday"

**Cross-area search**:
- "Search the entire notebook for 'budget'"

Always include enough detail in the request so the sub-agent can act without ambiguity (e.g. specify note titles, habit names, dates, file paths).`,
    parameters: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'A natural language instruction describing what to do in the notebook. Be specific: include titles, tags, dates, file paths, or content as needed.',
        },
      },
      required: ['request'],
    },
  },
}

// ─── Plugin message & state types ───

type PluginMsg =
  | { type: 'config'; slice: NotebookConfig | undefined }

type PluginState = {
  initialized:  boolean
  gen:          number
  notebookDir:  string
  model:        string
  maxToolLoops: number
  journalRef:   ActorRef<ToolInvokeMsg> | null
  notesRef:     ActorRef<ToolInvokeMsg> | null
  trackerRef:   ActorRef<ToolInvokeMsg> | null
  todosRef:     ActorRef<ToolInvokeMsg> | null
  searchRef:    ActorRef<ToolInvokeMsg> | null
  noteAgentRef: ActorRef<NoteAgentMsg>  | null
  reminderRef:  ActorRef<TodoReminderMsg> | null
}

// ─── Tool collection builder ───

const buildToolCollection = (
  journalRef:  ActorRef<ToolInvokeMsg>,
  notesRef:    ActorRef<ToolInvokeMsg>,
  trackerRef:  ActorRef<ToolInvokeMsg>,
  todosRef:    ActorRef<ToolInvokeMsg>,
  searchRef:   ActorRef<ToolInvokeMsg>,
): ToolCollection => ({
  [JOURNAL_WRITE_TOOL_NAME]:        { schema: JOURNAL_WRITE_SCHEMA,        ref: journalRef },
  [JOURNAL_READ_TOOL_NAME]:         { schema: JOURNAL_READ_SCHEMA,         ref: journalRef },
  [JOURNAL_SEARCH_TOOL_NAME]:       { schema: JOURNAL_SEARCH_SCHEMA,       ref: journalRef },
  [NOTES_CREATE_TOOL_NAME]:         { schema: NOTES_CREATE_SCHEMA,         ref: notesRef   },
  [NOTES_UPDATE_TOOL_NAME]:         { schema: NOTES_UPDATE_SCHEMA,         ref: notesRef   },
  [NOTES_READ_TOOL_NAME]:           { schema: NOTES_READ_SCHEMA,           ref: notesRef   },
  [NOTES_LIST_TOOL_NAME]:           { schema: NOTES_LIST_SCHEMA,           ref: notesRef   },
  [NOTES_SEARCH_TOOL_NAME]:         { schema: NOTES_SEARCH_SCHEMA,         ref: notesRef   },
  [NOTES_ATTACH_FILE_TOOL_NAME]:    { schema: NOTES_ATTACH_FILE_SCHEMA,    ref: notesRef   },
  [NOTES_DELETE_TOOL_NAME]:         { schema: NOTES_DELETE_SCHEMA,         ref: notesRef   },
  [TRACKER_LOG_TOOL_NAME]:          { schema: TRACKER_LOG_SCHEMA,          ref: trackerRef  },
  [TRACKER_STATS_TOOL_NAME]:        { schema: TRACKER_STATS_SCHEMA,        ref: trackerRef  },
  [TRACKER_DEFINE_HABIT_TOOL_NAME]: { schema: TRACKER_DEFINE_HABIT_SCHEMA, ref: trackerRef  },
  [TRACKER_LIST_HABITS_TOOL_NAME]:  { schema: TRACKER_LIST_HABITS_SCHEMA,  ref: trackerRef  },
  [TODOS_CREATE_TOOL_NAME]:         { schema: TODOS_CREATE_SCHEMA,         ref: todosRef    },
  [TODOS_COMPLETE_TOOL_NAME]:       { schema: TODOS_COMPLETE_SCHEMA,       ref: todosRef    },
  [TODOS_LIST_TOOL_NAME]:           { schema: TODOS_LIST_SCHEMA,           ref: todosRef    },
  [TODOS_DELETE_TOOL_NAME]:         { schema: TODOS_DELETE_SCHEMA,         ref: todosRef    },
  [TODOS_UPDATE_TOOL_NAME]:         { schema: TODOS_UPDATE_SCHEMA,         ref: todosRef    },
  [NOTEBOOK_SEARCH_TOOL_NAME]:      { schema: NOTEBOOK_SEARCH_SCHEMA,      ref: searchRef   },
})

// ─── Spawn helpers (typed with ActorContext<PluginMsg>) ───

type SpawnResult = Pick<PluginState,
  'journalRef' | 'notesRef' | 'trackerRef' | 'todosRef' | 'searchRef' |
  'noteAgentRef' | 'reminderRef'
>

const spawnChildren = (
  gen: number,
  notebookDir: string,
  model: string,
  maxToolLoops: number,
  ctx: ActorContext<PluginMsg>,
): SpawnResult => {
  // Spawn internal tool actors — NOT registered on ToolRegistrationTopic
  const journalRef = ctx.spawn(`journal-${gen}`, createJournalActor(notebookDir), null) as ActorRef<ToolInvokeMsg>
  const notesRef   = ctx.spawn(`notes-${gen}`,   createNotesActor(notebookDir),   null) as ActorRef<ToolInvokeMsg>
  const trackerRef = ctx.spawn(`tracker-${gen}`, createTrackerActor(notebookDir), null) as ActorRef<ToolInvokeMsg>
  const todosRef   = ctx.spawn(`todos-${gen}`,   createTodosActor(notebookDir),   null) as ActorRef<ToolInvokeMsg>
  const searchRef  = ctx.spawn(`search-${gen}`,  createSearchActor(notebookDir),  null) as ActorRef<ToolInvokeMsg>

  const internalTools = buildToolCollection(journalRef, notesRef, trackerRef, todosRef, searchRef)

  // Spawn note agent
  const agentOpts = { model, notebookDir, maxToolLoops, tools: internalTools }
  const noteAgentRef = ctx.spawn(
    `note-agent-${gen}`,
    createNoteAgentActor(agentOpts),
    createInitialNoteAgentState(agentOpts),
  ) as ActorRef<NoteAgentMsg>

  // Register the single public tool
  ctx.publishRetained(ToolRegistrationTopic, NOTE_TOOL_NAME, {
    name:   NOTE_TOOL_NAME,
    schema: NOTE_SCHEMA,
    ref:    noteAgentRef as unknown as ActorRef<ToolInvokeMsg>,
  })

  // Spawn todo reminder
  const reminderRef = ctx.spawn(
    `todo-reminder-${gen}`,
    createTodoReminderActor(notebookDir),
    INITIAL_TODO_REMINDER_STATE(notebookDir),
  ) as ActorRef<TodoReminderMsg>

  return { journalRef, notesRef, trackerRef, todosRef, searchRef, noteAgentRef, reminderRef }
}

const stopChildren = (state: PluginState, ctx: ActorContext<PluginMsg>): void => {
  if (state.journalRef)   ctx.stop(state.journalRef)
  if (state.notesRef)     ctx.stop(state.notesRef)
  if (state.trackerRef)   ctx.stop(state.trackerRef)
  if (state.todosRef)     ctx.stop(state.todosRef)
  if (state.searchRef)    ctx.stop(state.searchRef)
  if (state.noteAgentRef) ctx.stop(state.noteAgentRef)
  if (state.reminderRef)  ctx.stop(state.reminderRef)
  ctx.deleteRetained(ToolRegistrationTopic, NOTE_TOOL_NAME, { name: NOTE_TOOL_NAME, ref: null })
}

// ─── Plugin definition ───

const notebookPlugin: PluginDef<PluginMsg, PluginState, NotebookConfig> = {
  id:          'notebook',
  version:     '1.0.0',
  description: 'Personal notebook: journal, notes, tracker (habits, expenses, or any numeric metric), todos — exposed as a single "note" tool.',

  configDescriptor: {
    defaults: {
      notebookDir:  'workspace/notebook',
      maxToolLoops: 10,
    },
    onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
  },

  initialState: {
    initialized:  false,
    gen:          0,
    notebookDir:  'workspace/notebook',
    model:        '',
    maxToolLoops: 10,
    journalRef:   null,
    notesRef:     null,
    trackerRef:   null,
    todosRef:     null,
    searchRef:    null,
    noteAgentRef: null,
    reminderRef:  null,
  },

  lifecycle: onLifecycle({
    start: (state, ctx) => {
      const config      = ctx.initialConfig() as NotebookConfig | undefined
      const notebookDir = config?.notebookDir  ?? 'workspace/notebook'
      const model       = config?.agentModel   ?? 'google/gemini-3.1-pro-preview'
      const maxToolLoops = config?.maxToolLoops ?? 10

      const children = spawnChildren(0, notebookDir, model, maxToolLoops, ctx)

      ctx.log.info('notebook plugin activated', { notebookDir })

      return {
        state: {
          ...state,
          initialized: true,
          gen: 0,
          notebookDir,
          model,
          maxToolLoops,
          ...children,
        },
      }
    },

    stopped: (state, ctx) => {
      stopChildren(state, ctx)
      ctx.log.info('notebook plugin deactivating')
      return { state }
    },
  }),

  handler: onMessage<PluginMsg, PluginState>({
    config: (state, msg, ctx) => {
      stopChildren(state, ctx)
      const cfg          = msg.slice
      const notebookDir  = cfg?.notebookDir  ?? 'workspace/notebook'
      const model        = cfg?.agentModel   ?? 'google/gemini-3.1-pro-preview'
      const maxToolLoops = cfg?.maxToolLoops ?? 10
      const gen          = state.gen + 1

      const children = spawnChildren(gen, notebookDir, model, maxToolLoops, ctx)

      return {
        state: {
          ...state,
          gen,
          notebookDir,
          model,
          maxToolLoops,
          ...children,
        },
      }
    },
  }),
}

export default notebookPlugin
