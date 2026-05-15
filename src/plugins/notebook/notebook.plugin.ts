import { resolve, sep } from 'node:path'
import type { ActorContext, ActorRef, PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { defineTool, ToolRegistrationTopic } from '../../types/tools.ts'
import type { ToolCollection, ToolMsg } from '../../types/tools.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import { IdentityProviderTopic, resolveCookieIdentity } from '../../types/identity.ts'
import type { IdentityProviderMsg } from '../../types/identity.ts'

import type { NoteEntry, NotebookConfig, NoteAgentMsg, TodoReminderMsg } from './types.ts'

import { Journal, journalWriteTool, journalReadTool, journalSearchTool } from './tools/journal.ts'
import { Notes, notesCreateTool, notesUpdateTool, notesReadTool, notesListTool, notesSearchTool, notesAttachFileTool, notesDeleteTool } from './tools/notes.ts'
import { Tracker, trackerLogTool, trackerStatsTool, trackerDefineHabitTool, trackerListHabitsTool } from './tools/tracker.ts'
import { Todos, todosCreateTool, todosCompleteTool, todosListTool, todosDeleteTool, todosUpdateTool } from './tools/todos.ts'
import { Search, notebookSearchTool } from './tools/search.ts'
import { NoteAgent } from './note-agent.ts'
import { TodoReminder } from './todo-reminder.ts'

// ─── Public tool schema ───

const ATTACHMENT_ROUTE_ID = 'notebook.attachments.api'
const ATTACHMENT_ROUTE_PREFIX = '/notebook/attachments/'
const MEDIA_DIR = resolve(import.meta.dir, '../../..', 'workspace/media')

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
  initialized:  boolean
  gen:          number
  notebookDir:  string
  model:        string
  maxToolLoops: number
  journalRef:   ActorRef<ToolMsg> | null
  notesRef:     ActorRef<ToolMsg> | null
  trackerRef:   ActorRef<ToolMsg> | null
  todosRef:     ActorRef<ToolMsg> | null
  searchRef:    ActorRef<ToolMsg> | null
  noteAgentRef: ActorRef<NoteAgentMsg>  | null
  reminderRef:  ActorRef<TodoReminderMsg> | null
}

type SharedRefs = {
  identityProviderRef: ActorRef<IdentityProviderMsg> | null
  notebookDir:         string
}

const resolveUnder = (baseDir: string, relPath: string): string | null => {
  const base = resolve(baseDir)
  const filePath = resolve(base, relPath)
  return filePath === base || filePath.startsWith(base + sep) ? filePath : null
}

const registerRoutes = (ctx: ActorContext<PluginMsg>, refs: SharedRefs): void => {
  ctx.publishRetained(RouteRegistrationTopic, ATTACHMENT_ROUTE_ID, {
    id: ATTACHMENT_ROUTE_ID,
    method: 'GET',
    path: ATTACHMENT_ROUTE_PREFIX,
    match: 'prefix',
    handler: async (req: Request, url: URL) => {
      const session = await resolveCookieIdentity(refs.identityProviderRef, req)

      if (!session) return new Response('Unauthorized', { status: 401 })

      let attachmentId: string
      try {
        attachmentId = decodeURIComponent(url.pathname.slice(ATTACHMENT_ROUTE_PREFIX.length))
      } catch {
        return new Response('Bad request', { status: 400 })
      }

      if (!attachmentId || attachmentId.includes('/')) return new Response('Not Found', { status: 404 })

      const indexFile = Bun.file(`${refs.notebookDir}/notes/index.json`)
      if (!await indexFile.exists()) return new Response('Not Found', { status: 404 })

      const index = JSON.parse(await indexFile.text()) as { notes: NoteEntry[] }
      const attachment = index.notes.flatMap(n => n.attachments ?? []).find(a => a.id === attachmentId)
      if (!attachment) return new Response('Not Found', { status: 404 })

      const filePath = resolveUnder(MEDIA_DIR, attachment.path)
      if (!filePath) return new Response('Not Found', { status: 404 })

      const file = Bun.file(filePath)
      if (!await file.exists()) return new Response('Not Found', { status: 404 })

      return new Response(file, {
        headers: {
          'Content-Type': attachment.mimeType,
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`,
        },
      })
    },
  })
}

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

const notebookPlugin: PluginDef<PluginMsg, PluginState, NotebookConfig> = (() => {
  const refs: SharedRefs = { identityProviderRef: null, notebookDir: 'workspace/notebook' }

  return {
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
        const config       = ctx.initialConfig() as NotebookConfig | undefined
        const notebookDir  = config?.notebookDir  ?? 'workspace/notebook'
        const model        = config?.agentModel   ?? 'google/gemini-3.1-pro-preview'
        const maxToolLoops = config?.maxToolLoops ?? 10

        refs.notebookDir = notebookDir
        ctx.subscribe(IdentityProviderTopic, (e) => ({ type: '_identityProvider' as const, ref: e.ref }))
        registerRoutes(ctx, refs)

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
        ctx.deleteRetained(RouteRegistrationTopic, ATTACHMENT_ROUTE_ID, { id: ATTACHMENT_ROUTE_ID, method: 'GET', path: ATTACHMENT_ROUTE_PREFIX, match: 'prefix', handler: null })
        refs.identityProviderRef = null
        ctx.log.info('notebook plugin deactivating')
        return { state }
      },
    }),

    handler: onMessage<PluginMsg, PluginState>({
      _identityProvider: (state, msg) => {
        refs.identityProviderRef = msg.ref
        return { state }
      },

      config: (state, msg, ctx) => {
        stopChildren(state, ctx)
        const cfg          = msg.slice
        const notebookDir  = cfg?.notebookDir  ?? 'workspace/notebook'
        const model        = cfg?.agentModel   ?? 'google/gemini-3.1-pro-preview'
        const maxToolLoops = cfg?.maxToolLoops ?? 10
        const gen          = state.gen + 1

        refs.notebookDir = notebookDir
        registerRoutes(ctx, refs)

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
})()

export default notebookPlugin
