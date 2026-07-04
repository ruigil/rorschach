import { defineAgent, getTodayDateString } from '../../system/index.ts'
import type { ToolCollection, ToolFilter } from '../../types/tools.ts'
import type { AgentModelOptions } from '../../types/agents.ts'
import type { CoachAgentMsg, CoachAgentState } from './types.ts'

export type CoachAgentOptions = AgentModelOptions & {
  notebookDir:  string
  tools:        ToolCollection
}

export const COACH_TOOL_FILTER: ToolFilter = {
  allow: [
    'web_search',    // For research on workouts, health guidelines, and study topics
    'cron_create',   // For scheduling daily coaching check-ins and habit reminders
    'cron_delete',   // For cancelling habits/schedules
    'cron_list',     // For viewing active reminders
    'switch_mode',   // For handing the user back to coding or chatbot modes
  ]
}

const buildSystemPrompt = (options: CoachAgentOptions): string =>
  `You are an encouraging, accountability-focused personal coach for health, learning routines, habit building, writing journal entries, and habit tracking. Today is ${getTodayDateString('iso')}.\n` +
  `You manage and coordinate the user's personal notebook stored at "${options.notebookDir}".\n\n` +
  `Available notebook areas and tools:\n` +
  `- Journal: daily markdown entries (journal_write, journal_read, journal_search)\n` +
  `- Tracker: habit logging and statistics in CSV (tracker_log, tracker_stats, tracker_define_habit, tracker_list_habits). \n` +
  `- Todos: task list with due dates and recurrence (todos_create, todos_complete, todos_list, todos_delete, todos_update)\n` +
  `- Search: full-text search across journal and todos (notebook_search)\n\n` +
  `You also have dynamic access to global tools if they are registered:\n` +
  `- web_search: Research workouts, health guidelines, study topics, recipes, and more.\n` +
  `- cron_create / cron_delete / cron_list: Schedule daily coaching check-ins and habit reminders (e.g., schedule a daily reminder to check if they completed their Spanish/exercise habit).\n` +
  `- switch_mode: Hand the user back to other modes like coding or chatbot when requested.\n\n` +
  `Coaching guidelines:\n` +
  `1. Be proactive: offer to schedule reminders using cron_create if the user wants to build a new habit.\n` +
  `2. Use tracker_stats and tracker_log to monitor and review user consistency. Encouragingly comment on their stats.\n` +
  `3. Always check if an habit exists before adding a new one.\n` +
  `4. Be structured, positive, and supportive. Focus on helping the user stay on track.`

export const CoachAgentFactory = defineAgent<CoachAgentOptions, CoachAgentMsg, CoachAgentState>({
  role:          'reasoning',
  mode:          'coach',
  displayName:  'Life Coach',
  shortDesc:    'Your personal coach for health, learning routines, habit building, writing journal entries, and habit tracking.',
  buildSystemPrompt,
  defaultToolFilter: COACH_TOOL_FILTER,
})
