import { createPluginFactory } from '../../system/index.ts'
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
      options: (cfg) => ({
        model: cfg.agent?.model ?? 'google/gemini-3.5-flash',
        maxToolLoops: cfg.agent?.maxToolLoops ?? 15,
        agentSCRs: [
          'scr:leaf:notebook.journal_write',
          'scr:leaf:notebook.journal_read',
          'scr:leaf:notebook.journal_search',
          'scr:leaf:notebook.tracker_log',
          'scr:leaf:notebook.tracker_stats',
          'scr:leaf:notebook.tracker_define_habit',
          'scr:leaf:notebook.tracker_list_habits',
          'scr:leaf:notebook.todos_create',
          'scr:leaf:notebook.todos_complete',
          'scr:leaf:notebook.todos_list',
          'scr:leaf:notebook.todos_delete',
          'scr:leaf:notebook.todos_update',
          'scr:leaf:notebook.search',
          'scr:leaf:tools.web_search',
          'scr:leaf:tools.cron_create',
          'scr:leaf:tools.cron_delete',
          'scr:leaf:tools.cron_list',
        ],
      }),
    },
  },
})
