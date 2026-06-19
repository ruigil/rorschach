import type { ActorContext, ActorRef, PluginDef } from '../../system/index.ts'
import { defineConfig, publishConfigSurface, deleteConfigSurface } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { defineTool } from '../../system/index.ts'
import { ToolRegistrationTopic, type ToolCollection, type ToolMsg } from '../../types/tools.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'

import type { NotebookConfig, NoteAgentMsg } from './types.ts'

import { Journal, journalWriteTool, journalReadTool, journalSearchTool } from './tools/journal.ts'
import { Tracker, trackerLogTool, trackerStatsTool, trackerDefineHabitTool, trackerListHabitsTool } from './tools/tracker.ts'
import { Todos, todosCreateTool, todosCompleteTool, todosListTool, todosDeleteTool, todosUpdateTool } from './tools/todos.ts'
import { Search, notebookSearchTool } from './tools/search.ts'
import { NoteAgent } from './note-agent.ts'
import { buildNotebookRoutes, notebookSchemas } from './routes.ts'

// ─── Public tool schema ───

export const noteTool = defineTool('note', `Interact with your personal notebook via a natural language request. A sub-agent handles the request and returns a summary of what was done.

This tool is for the user only — only call it when explicitly asked by the user. Never use it to take notes for yourself.

The notebook has three areas — use the request field to describe exactly what you want:

**Journal** — daily markdown diary entries:
- "Write a journal entry: had a productive morning, finished the auth PR"
- "Read my journal entry for 2025-11-03"
- "Search the journal for mentions of 'deployment'"

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
- "Search journal and todos for 'budget'"

Always include enough detail in the request so the sub-agent can act without ambiguity (e.g. specify habit names, dates, file paths, or todo text).`, {
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

type PluginState = {
  initialized:          boolean
  gen:                  number
  notebookDir:          string
  model:                string
  maxToolLoops:         number
  journalRef:           ActorRef<ToolMsg> | null
  trackerRef:           ActorRef<ToolMsg> | null
  todosRef:             ActorRef<ToolMsg> | null
  searchRef:            ActorRef<ToolMsg> | null
  noteAgentRef:         ActorRef<NoteAgentMsg>  | null
}

const config = defineConfig<NotebookConfig>('notebook', {
  notebookDir:  'workspace/notebook',
  agentModel:   'google/gemini-3.1-pro-preview',
  maxToolLoops: 10,
}, {
  schemas: notebookSchemas,
})

// ─── Tool collection builder ───

const buildToolCollection = (
  journalRef:  ActorRef<ToolMsg>,
  trackerRef:  ActorRef<ToolMsg>,
  todosRef:    ActorRef<ToolMsg>,
  searchRef:   ActorRef<ToolMsg>,
): ToolCollection => ({
  [journalWriteTool.name]:        { ...journalWriteTool,        ref: journalRef },
  [journalReadTool.name]:         { ...journalReadTool,         ref: journalRef },
  [journalSearchTool.name]:       { ...journalSearchTool,       ref: journalRef },
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
  'journalRef' | 'trackerRef' | 'todosRef' | 'searchRef' |
  'noteAgentRef'
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
  const trackerRef = ctx.spawn(`tracker-${gen}`, Tracker(notebookDir)) as ActorRef<ToolMsg>
  const todosRef   = ctx.spawn(`todos-${gen}`,   Todos(notebookDir))   as ActorRef<ToolMsg>
  const searchRef  = ctx.spawn(`search-${gen}`,  Search(notebookDir))  as ActorRef<ToolMsg>

  const internalTools = buildToolCollection(journalRef, trackerRef, todosRef, searchRef)

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

  return { journalRef, trackerRef, todosRef, searchRef, noteAgentRef }
}

const stopChildren = (state: PluginState, ctx: ActorContext<PluginMsg>): void => {
  if (state.journalRef)   ctx.stop(state.journalRef)
  if (state.trackerRef)   ctx.stop(state.trackerRef)
  if (state.todosRef)     ctx.stop(state.todosRef)
  if (state.searchRef)    ctx.stop(state.searchRef)
  if (state.noteAgentRef) ctx.stop(state.noteAgentRef)
  ctx.deleteRetained(ToolRegistrationTopic, noteTool.name, { name: noteTool.name, ref: null })
}

// ─── Plugin definition ───

const notebookPlugin: PluginDef<PluginMsg, PluginState, NotebookConfig> = {
  id:          'notebook',
  version:     '1.0.0',
  description: 'Personal notebook: journal, tracker (habits, expenses, or any numeric metric), todos — exposed as a single "note" tool.',

  configDescriptor: config,

  initialState: {
    initialized:         false,
    gen:                 0,
    notebookDir:         'workspace/notebook',
    model:               '',
    maxToolLoops:        10,
    journalRef:          null,
    trackerRef:          null,
    todosRef:            null,
    searchRef:           null,
    noteAgentRef:        null,
  },

  lifecycle: onLifecycle({
    start: (state, ctx) => {
      const cfg          = ctx.initialConfig() as NotebookConfig | undefined
      const notebookDir  = cfg?.notebookDir  ?? 'workspace/notebook'
      const model        = cfg?.agentModel   ?? 'google/gemini-3.1-pro-preview'
      const maxToolLoops = cfg?.maxToolLoops ?? 10

      publishConfigSurface(ctx, config, () => cfg)

      for (const reg of buildNotebookRoutes(notebookDir)) {
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
      for (const reg of buildNotebookRoutes(state.notebookDir)) {
        ctx.deleteRetained(RouteRegistrationTopic, reg.id, { id: reg.id, method: reg.method, path: reg.path, match: reg.match, handler: null })
      }

      deleteConfigSurface(ctx, config)

      ctx.log.info('notebook plugin deactivating')
      return { state }
    },
  }),

  handler: onMessage<PluginMsg, PluginState>({
    config: (state, msg, ctx) => {
      // Tombstone old routes
      for (const reg of buildNotebookRoutes(state.notebookDir)) {
        ctx.deleteRetained(RouteRegistrationTopic, reg.id, { id: reg.id, method: reg.method, path: reg.path, match: reg.match, handler: null })
      }

      stopChildren(state, ctx)
      const cfg          = msg.slice
      const notebookDir  = cfg?.notebookDir  ?? 'workspace/notebook'
      const model        = cfg?.agentModel   ?? 'google/gemini-3.1-pro-preview'
      const maxToolLoops = cfg?.maxToolLoops ?? 10
      const gen          = state.gen + 1

      // Re-register routes with new notebookDir
      for (const reg of buildNotebookRoutes(notebookDir)) {
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
