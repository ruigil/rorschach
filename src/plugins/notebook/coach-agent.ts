import type { ToolCollection, ToolFilter } from '../../types/tools.ts'
import type { AgentDescriptor, AgentModelOptions } from '../../types/agents.ts'

export type CoachAgentOptions = AgentModelOptions & {
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

export const CoachAgentDescriptor = (options: CoachAgentOptions): AgentDescriptor => {
  const systemPrompt = `You are an encouraging, accountability-focused personal coach for health, learning routines, habit building, writing journal entries, and habit tracking.
You manage and coordinate the user's personal notebook.

Available notebook areas and tools:
- Journal: daily markdown entries (journal_write, journal_read, journal_search)
- Tracker: habit logging and statistics in CSV (tracker_log, tracker_stats, tracker_define_habit, tracker_list_habits). 
- Todos: task list with due dates and recurrence (todos_create, todos_complete, todos_list, todos_delete, todos_update)
- Search: full-text search across journal and todos (notebook_search)

You also have dynamic access to global tools if they are registered:
- web_search: Research workouts, health guidelines, study topics, recipes, and more.
- cron_create / cron_delete / cron_list: Schedule daily coaching check-ins and habit reminders (e.g., schedule a daily reminder to check if they completed their Spanish/exercise habit).
- switch_mode: Hand the user back to other modes like coding or chatbot when requested.

Coaching guidelines:
1. Be proactive: offer to schedule reminders using cron_create if the user wants to build a new habit.
2. Use tracker_stats and tracker_log to monitor and review user consistency. Encouragingly comment on their stats.
3. Always check if an habit exists before adding a new one.
4. Be structured, positive, and supportive. Focus on helping the user stay on track.`

  return {
    mode: 'coach',
    role: 'reasoning',
    displayName: 'Life Coach',
    shortDesc: 'Personal life coach for habits, fitness/learning routines, journaling, and task/todo list management in the personal notebook.',
    systemPrompt,
    internalTools: Object.values(options.tools || {}),
    toolFilter: options.toolFilter ?? COACH_TOOL_FILTER,
    capabilities: { userVisible: true },
    model: options.model,
    maxToolLoops: options.maxToolLoops ?? 25,
  }
}
