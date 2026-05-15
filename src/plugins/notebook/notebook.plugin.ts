import type { ActorContext, ActorRef, PluginDef } from '../../system/types.ts'
import { defineConfig, createSlot, type ActorSlot } from '../../system/config.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { defineTool, ToolRegistrationTopic } from '../../types/tools.ts'
import type { ToolCollection, ToolMsg } from '../../types/tools.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import { ConfigSchemaTopic } from '../../types/config.ts'
import { IdentityProviderTopic } from '../../types/identity.ts'
import type { IdentityProviderMsg } from '../../types/identity.ts'

import type { NotebookConfig, NoteAgentMsg, TodoReminderMsg } from './types.ts'

import { Journal, journalWriteTool, journalReadTool, journalSearchTool } from './tools/journal.ts'
import { Notes, notesCreateTool, notesUpdateTool, notesReadTool, notesListTool, notesSearchTool, notesAttachFileTool, notesDeleteTool } from './tools/notes.ts'
import { Tracker, trackerLogTool, trackerStatsTool, trackerDefineHabitTool, trackerListHabitsTool } from './tools/tracker.ts'
import { Todos, todosCreateTool, todosCompleteTool, todosListTool, todosDeleteTool, todosUpdateTool } from './tools/todos.ts'
import { Search, notebookSearchTool } from './tools/search.ts'
import { NoteAgent } from './note-agent.ts'
import { TodoReminder } from './todo-reminder.ts'
import { buildNotebookRoutes, notebookSchemas, buildNotebookConfigRoute, ATTACHMENT_ROUTE_ID, ATTACHMENT_ROUTE_PREFIX } from './routes.ts'

// ─── Public tool schema ───

export const noteTool = defineTool('note', `Interact with your personal notebook via a natural language request. A sub-agent handles the request and returns a summary of what was done.

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

Always include enough detail in the request so the sub-agent can act without ambiguity (e.g. specify note titles, habit names, dates, file paths).`, {
  type: 'object',
  properties: {
    request: {
      type: 'string',
      description: 'A natural language instruction describing what to do in the notebook. Be specific: include titles, tags, dates, file paths, or content as needed.',
    },
  },
  required: ['request'],
})

// ─── Plugin message & state types ───

type PluginMsg =
  | { type: 'config'; slice: NotebookConfig | undefined }
  | { type: '_identityProvider'; ref: ActorRef<IdentityProviderMsg> | null }

type PluginState = {
  initialized:          boolean
  gen:                  number
  notebookDir:          string
  model:                string
  maxToolLoops:         number
  journalRef:           ActorRef<ToolMsg> | null
  notesRef:             ActorRef<ToolMsg> | null
  trackerRef:           ActorRef<ToolMsg> | null
  todosRef:             ActorRef<ToolMsg> | null
  searchRef:            ActorRef<ToolMsg> | null
  noteAgentRef:         ActorRef<NoteAgentMsg>  | null
  reminderRef:          ActorRef<TodoReminderMsg> | null
  identityProviderRef:  ActorRef<IdentityProviderMsg> | null
}

const config = defineConfig<NotebookConfig>('notebook', {
  notebookDir:  'workspace/notebook',
  agentModel:   'google/gemini-3.1-pro-preview',
  maxToolLoops: 10,
})

// ─── Tool collection builder ───

const buildToolCollection = (
  journalRef:  ActorRef<ToolMsg>,
  notesRef:    ActorRef<ToolMsg>,
  trackerRef:  ActorRef<ToolMsg>,
  todosRef:    ActorRef<ToolMsg>,
  searchRef:   ActorRef<ToolMsg>,
): ToolCollection => ({
  [journalWriteTool.name]:        { ...journalWriteTool,        ref: journalRef },
  [journalReadTool.name]:         { ...journalReadTool,         ref: journalRef },
  [journalSearchTool.name]:       { ...journalSearchTool,       ref: journalRef },
  [notesCreateTool.name]:         { ...notesCreateTool,         ref: notesRef   },
  [notesUpdateTool.name]:         { ...notesUpdateTool,         ref: notesRef   },
  [notesReadTool.name]:           { ...notesReadTool,           ref: notesRef   },
  [notesListTool.name]:           { ...notesListTool,           ref: notesRef   },
  [notesSearchTool.name]:         { ...notesSearchTool,         ref: notesRef   },
  [notesAttachFileTool.name]:     { ...notesAttachFileTool,     ref: notesRef   },
  [notesDeleteTool.name]:         { ...notesDeleteTool,         ref: notesRef   },
  [trackerLogTool.name]:          { ...trackerLogTool,          ref: trackerRef  },
  [trackerStatsTool.name]:        { ...trackerStatsTool,        ref: trackerRef  },
  [trackerDefineHabitTool.name]:  { ...trackerDefineHabitTool,  ref: trackerRef  },
  [trackerListHabitsTool.name]:   { ...trackerListHabitsTool,   ref: trackerRef  },
  [todosCreateTool.name]:         { ...todosCreateTool,         ref: todosRef    },
  [todosCompleteTool.name]:       { ...todosCompleteTool,       ref: todosRef    },
  [todosListTool.name]:           { ...todosListTool,           ref: todosRef    },
  [todosDeleteTool.name]:         { ...todosDeleteTool,         ref: todosRef    },
  [todosUpdateTool.name]:         { ...todosUpdateTool,         ref: todosRef    },
  [notebookSearchTool.name]:      { ...notebookSearchTool,      ref: searchRef   },
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
  const journalRef = ctx.spawn(`journal-${gen}`, Journal(notebookDir)) as ActorRef<ToolMsg>
  const notesRef   = ctx.spawn(`notes-${gen}`,   Notes(notebookDir))   as ActorRef<ToolMsg>
  const trackerRef = ctx.spawn(`tracker-${gen}`, Tracker(notebookDir)) as ActorRef<ToolMsg>
  const todosRef   = ctx.spawn(`todos-${gen}`,   Todos(notebookDir))   as ActorRef<ToolMsg>
  const searchRef  = ctx.spawn(`search-${gen}`,  Search(notebookDir))  as ActorRef<ToolMsg>

  const internalTools = buildToolCollection(journalRef, notesRef, trackerRef, todosRef, searchRef)

  // Spawn note agent
  const agentOpts = { model, notebookDir, maxToolLoops, tools: internalTools }
  const noteAgentRef = ctx.spawn(
    `note-agent-${gen}`,
    NoteAgent(agentOpts),
  ) as ActorRef<NoteAgentMsg>

  // Register the single public tool
  ctx.publishRetained(ToolRegistrationTopic, noteTool.name, {
    ...noteTool,
    ref: noteAgentRef as unknown as ActorRef<ToolMsg>,
  })

  // Spawn todo reminder
  const reminderRef = ctx.spawn(
    `todo-reminder-${gen}`,
    TodoReminder(notebookDir),
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
  ctx.deleteRetained(ToolRegistrationTopic, noteTool.name, { name: noteTool.name, ref: null })
}

// ─── Plugin definition ───

const notebookPlugin: PluginDef<PluginMsg, PluginState, NotebookConfig> = {
  id:          'notebook',
  version:     '1.0.0',
  description: 'Personal notebook: journal, notes, tracker (habits, expenses, or any numeric metric), todos — exposed as a single "note" tool.',

  configDescriptor: config,

  initialState: {
    initialized:         false,
    gen:                 0,
    notebookDir:         'workspace/notebook',
    model:               '',
    maxToolLoops:        10,
    journalRef:          null,
    notesRef:            null,
    trackerRef:          null,
    todosRef:            null,
    searchRef:           null,
    noteAgentRef:        null,
    reminderRef:         null,
    identityProviderRef: null,
  },

  lifecycle: onLifecycle({
    start: (state, ctx) => {
      const cfg          = ctx.initialConfig() as NotebookConfig | undefined
      const notebookDir  = cfg?.notebookDir  ?? 'workspace/notebook'
      const model        = cfg?.agentModel   ?? 'google/gemini-3.1-pro-preview'
      const maxToolLoops = cfg?.maxToolLoops ?? 10

      // Publish config schemas and config route
      for (const section of notebookSchemas) {
        ctx.publishRetained(ConfigSchemaTopic, section.id, section)
      }
      for (const reg of buildNotebookConfigRoute(() => cfg)) {
        ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
      }

      ctx.subscribe(IdentityProviderTopic, (e) => ({ type: '_identityProvider' as const, ref: e.ref }))

      for (const reg of buildNotebookRoutes(null, notebookDir)) {
        ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
      }

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
      for (const reg of buildNotebookRoutes(state.identityProviderRef, state.notebookDir)) {
        ctx.deleteRetained(RouteRegistrationTopic, reg.id, { id: reg.id, method: reg.method, path: reg.path, match: reg.match, handler: null })
      }

      // Tombstone config schemas and config route
      for (const section of notebookSchemas) {
        ctx.deleteRetained(ConfigSchemaTopic, section.id, { ...section, schema: null })
      }
      for (const reg of buildNotebookConfigRoute(() => undefined)) {
        ctx.deleteRetained(RouteRegistrationTopic, reg.id, { id: reg.id, method: reg.method, path: reg.path, handler: null })
      }

      ctx.log.info('notebook plugin deactivating')
      return { state }
    },
  }),

  handler: onMessage<PluginMsg, PluginState>({
    _identityProvider: (state, msg, ctx) => {
      for (const reg of buildNotebookRoutes(state.identityProviderRef, state.notebookDir)) {
        ctx.deleteRetained(RouteRegistrationTopic, reg.id, { id: reg.id, method: reg.method, path: reg.path, match: reg.match, handler: null })
      }

      const nextState = { ...state, identityProviderRef: msg.ref }

      for (const reg of buildNotebookRoutes(msg.ref, state.notebookDir)) {
        ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
      }

      return { state: nextState }
    },

    config: (state, msg, ctx) => {
      // Tombstone old routes
      for (const reg of buildNotebookRoutes(state.identityProviderRef, state.notebookDir)) {
        ctx.deleteRetained(RouteRegistrationTopic, reg.id, { id: reg.id, method: reg.method, path: reg.path, match: reg.match, handler: null })
      }

      stopChildren(state, ctx)
      const cfg          = msg.slice
      const notebookDir  = cfg?.notebookDir  ?? 'workspace/notebook'
      const model        = cfg?.agentModel   ?? 'google/gemini-3.1-pro-preview'
      const maxToolLoops = cfg?.maxToolLoops ?? 10
      const gen          = state.gen + 1

      // Re-register routes with new notebookDir
      for (const reg of buildNotebookRoutes(state.identityProviderRef, notebookDir)) {
        ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
      }

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
