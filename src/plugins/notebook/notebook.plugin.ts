import { createPluginFactory, defineConfig } from '../../system/index.ts'
import type { ActorRef } from '../../system/index.ts'
import type { ToolCollection, ToolMsg } from '../../types/tools.ts'
import type { NotebookConfig } from './types.ts'
import type { UiSurfaceRegistration } from '../../types/ui-surface.ts'

const notebookSurfaceRegistration: UiSurfaceRegistration = {
  id: 'notebook',
  version: '1.0.0',
  view: {
    title: 'Notebook',
    icon: 'file-text',
    contentTag: 'r-notebook-workspace',
    modes: ['coach'],
  },
  moduleUrl: '/js/plugins/notebook.js',
  frameTypes: [
    'notebookTodosList',
    'notebookJournalMonths',
    'notebookJournalEntry',
    'notebookTrackerHabits',
    'notebookTrackerEntries',
    'notebookTrackerStats',
    'notebookError'
  ],
}

import { Journal, journalWriteTool, journalReadTool, journalSearchTool } from './tools/journal.ts'
import { Tracker, trackerLogTool, trackerStatsTool, trackerDefineHabitTool, trackerListHabitsTool } from './tools/tracker.ts'
import { Todos, todosCreateTool, todosCompleteTool, todosListTool, todosDeleteTool, todosUpdateTool } from './tools/todos.ts'
import { Search, notebookSearchTool } from './tools/search.ts'
import { CoachAgentFactory } from './coach-agent.ts'
import { NotebookManager } from './notebook-manager.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'

export const notebookSchema: ConfigSchemaSection = {
  id: 'notebook.config',
  title: 'Notebook',
  subtitle: 'notebook · journal, todos, and tracker',
  tab: 'notebook',
  configKey: '',
  routeId: 'config.notebook',
  schema: {
    type: 'object',
    properties: {
      agent: {
        type: 'object',
        properties: {
          model: { type: 'string', 'x-ui': { widget: 'model-select', label: 'Agent model' } },
          maxToolLoops: { type: 'number', default: 10, minimum: 1, maximum: 50 },
        },
      },
    },
  },
}

const notebookSchemas = [notebookSchema]

const config = defineConfig<NotebookConfig>('notebook', {
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

export default createPluginFactory<NotebookConfig>({
  id:          'notebook',
  version:     '1.0.0',
  description: 'Personal notebook: journal, tracker (habits, expenses, or any numeric metric), todos — exposed as a single "note" tool.',
  configDescriptor: config,
  uiSurface: notebookSurfaceRegistration,
  slots: {
    manager: {
      factory: () => NotebookManager(),
    },
    journal: {
      factory: () => Journal(),
    },
    tracker: {
      factory: () => Tracker(),
    },
    todos: {
      factory: () => Todos(),
    },
    search: {
      factory: () => Search(),
    },
  },
  agents: {
    coach: {
      factory: CoachAgentFactory,
      options: (cfg, deps) => ({
        model: cfg.agent?.model ?? 'google/gemini-3.5-flash',
        maxToolLoops: cfg.agent?.maxToolLoops ?? 15,
        tools: buildToolCollection(
          deps.journal as ActorRef<ToolMsg>,
          deps.tracker as ActorRef<ToolMsg>,
          deps.todos as ActorRef<ToolMsg>,
          deps.search as ActorRef<ToolMsg>,
        ),
        toolFilter: cfg.agent?.toolFilter,
      }),
      dependsOn: ['journal', 'tracker', 'todos', 'search', 'manager'],
    },
  },
})
