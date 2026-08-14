import { createPluginFactory } from '../../system/index.ts'
import type { ActorRef } from '../../system/index.ts'
import type { ToolCollection, ToolMsg } from '../../types/tools.ts'
import { config, type NotebookConfig } from './notebook.config.ts'
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
    'notebook.todos.list',
    'notebook.journal.months',
    'notebook.journal.entry',
    'notebook.tracker.habits',
    'notebook.tracker.entries',
    'notebook.tracker.stats',
    'notebook.error'
  ],
}

import { Journal, journalWriteTool, journalReadTool, journalSearchTool } from './tools/journal.ts'
import { Tracker, trackerLogTool, trackerStatsTool, trackerDefineHabitTool, trackerListHabitsTool } from './tools/tracker.ts'
import { Todos, todosCreateTool, todosCompleteTool, todosListTool, todosDeleteTool, todosUpdateTool } from './tools/todos.ts'
import { Search, notebookSearchTool } from './tools/search.ts'
import { CoachAgentDescriptor } from './coach-agent.ts'
import { NotebookManager } from './notebook-manager.ts'

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
  tools: {
    journalWrite: { schema: journalWriteTool.schema, slot: 'journal' },
    journalRead: { schema: journalReadTool.schema, slot: 'journal' },
    journalSearch: { schema: journalSearchTool.schema, slot: 'journal' },
    trackerLog: { schema: trackerLogTool.schema, slot: 'tracker' },
    trackerStats: { schema: trackerStatsTool.schema, slot: 'tracker' },
    trackerDefineHabit: { schema: trackerDefineHabitTool.schema, slot: 'tracker' },
    trackerListHabits: { schema: trackerListHabitsTool.schema, slot: 'tracker' },
    todosCreate: { schema: todosCreateTool.schema, slot: 'todos' },
    todosComplete: { schema: todosCompleteTool.schema, slot: 'todos' },
    todosList: { schema: todosListTool.schema, slot: 'todos' },
    todosDelete: { schema: todosDeleteTool.schema, slot: 'todos' },
    todosUpdate: { schema: todosUpdateTool.schema, slot: 'todos' },
    search: { schema: notebookSearchTool.schema, slot: 'search' },
  },
  agents: {
    coach: {
      factory: CoachAgentDescriptor,
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
