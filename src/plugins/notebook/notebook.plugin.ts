import type { ActorContext, ActorRef, PluginDef } from '../../system/index.ts'
import { defineConfig, publishConfigSurface, deleteConfigSurface } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { ToolRegistrationTopic, type ToolCollection, type ToolMsg } from '../../types/tools.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import { AgentRegistrationTopic, type AgentDescriptor } from '../../types/agents.ts'

import type { NotebookConfig } from './types.ts'

import { Journal, journalWriteTool, journalReadTool, journalSearchTool } from './tools/journal.ts'
import { Tracker, trackerLogTool, trackerStatsTool, trackerDefineHabitTool, trackerListHabitsTool } from './tools/tracker.ts'
import { Todos, todosCreateTool, todosCompleteTool, todosListTool, todosDeleteTool, todosUpdateTool } from './tools/todos.ts'
import { Search, notebookSearchTool } from './tools/search.ts'
import { CoachAgentFactory } from './coach-agent.ts'
import { buildNotebookRoutes, notebookSchemas } from './routes.ts'

// ─── Public tool schema ───

// ─── Coach Agent Descriptor Builder ───

const buildCoachDescriptor = (
  cfg: NotebookConfig,
  journalRef: ActorRef<ToolMsg>,
  trackerRef: ActorRef<ToolMsg>,
  todosRef: ActorRef<ToolMsg>,
  searchRef: ActorRef<ToolMsg>,
  notebookDir: string,
): AgentDescriptor => ({
  mode: 'coach',
  displayName: 'Coach',
  shortDesc: 'Your personal coach for health, learning routines, habit building, writing journal entries, and habit tracking.',
  factory: CoachAgentFactory({
    model: cfg.agent?.model ?? 'google/gemini-3.5-flash',
    maxToolLoops: cfg.agent?.maxToolLoops ?? 15,
    notebookDir: notebookDir,
    // Mount core tools permanently
    tools: buildToolCollection(journalRef, trackerRef, todosRef, searchRef),
    toolFilter: cfg.agent?.toolFilter,
  }),
  capabilities: { userVisible: true },
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
}

const config = defineConfig<NotebookConfig>('notebook', {
  notebookDir:  'workspace/notebook',
  agent: {
    model: 'google/gemini-3.1-pro-preview',
    maxToolLoops: 10,
  },
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
  'journalRef' | 'trackerRef' | 'todosRef' | 'searchRef'
>

const spawnChildren = (
  gen: number,
  notebookDir: string,
  model: string,
  maxToolLoops: number,
  ctx: ActorContext<PluginMsg>,
  cfg: NotebookConfig,
): SpawnResult => {
  // Spawn internal tool actors — NOT registered on ToolRegistrationTopic
  const journalRef = ctx.spawn(`journal-${gen}`, Journal(notebookDir)) as ActorRef<ToolMsg>
  const trackerRef = ctx.spawn(`tracker-${gen}`, Tracker(notebookDir)) as ActorRef<ToolMsg>
  const todosRef   = ctx.spawn(`todos-${gen}`,   Todos(notebookDir))   as ActorRef<ToolMsg>
  const searchRef  = ctx.spawn(`search-${gen}`,  Search(notebookDir))  as ActorRef<ToolMsg>

  // Register the coach agent mode
  ctx.publish(AgentRegistrationTopic, {
    type: 'register',
    descriptor: buildCoachDescriptor(cfg, journalRef, trackerRef, todosRef, searchRef, notebookDir),
  })

  return { journalRef, trackerRef, todosRef, searchRef }
}

const stopChildren = (state: PluginState, ctx: ActorContext<PluginMsg>): void => {
  if (state.journalRef) ctx.stop(state.journalRef)
  if (state.trackerRef) ctx.stop(state.trackerRef)
  if (state.todosRef)   ctx.stop(state.todosRef)
  if (state.searchRef)  ctx.stop(state.searchRef)
  ctx.publish(AgentRegistrationTopic, { type: 'unregister', mode: 'coach' })
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
  },

  lifecycle: onLifecycle({
    start: (state, ctx) => {
      const cfg          = ctx.initialConfig() as NotebookConfig | undefined
      const notebookDir  = cfg?.notebookDir  ?? 'workspace/notebook'
      const model        = cfg?.agent?.model   ?? 'google/gemini-3.1-pro-preview'
      const maxToolLoops = cfg?.agent?.maxToolLoops ?? 10

      publishConfigSurface(ctx, config, () => cfg)

      for (const reg of buildNotebookRoutes(notebookDir)) {
        ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
      }

      const children = spawnChildren(0, notebookDir, model, maxToolLoops, ctx, cfg ?? {})

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
      const model        = cfg?.agent?.model   ?? 'google/gemini-3.1-pro-preview'
      const maxToolLoops = cfg?.agent?.maxToolLoops ?? 10
      const gen          = state.gen + 1

      // Re-register routes with new notebookDir
      for (const reg of buildNotebookRoutes(notebookDir)) {
        ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
      }

      const children = spawnChildren(gen, notebookDir, model, maxToolLoops, ctx, cfg ?? {})

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
