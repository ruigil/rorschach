import type { ToolFilter } from '../../types/tools.ts'
import type { AgentDescriptor, AgentModelOptions } from '../../types/agents.ts'

export type CoachAgentOptions = AgentModelOptions & {
  agentSCRs?: string[]
}

export const COACH_TOOL_FILTER: ToolFilter = {
  allow: [
    'notebook_journal_write',
    'notebook_journal_read',
    'notebook_journal_search',
    'notebook_tracker_log',
    'notebook_tracker_stats',
    'notebook_tracker_define_habit',
    'notebook_tracker_list_habits',
    'notebook_todos_create',
    'notebook_todos_complete',
    'notebook_todos_list',
    'notebook_todos_delete',
    'notebook_todos_update',
    'notebook_search',
    'tools_web_search',    // For research on workouts, health guidelines, and study topics
    'tools_cron_create',   // For scheduling daily coaching check-ins and habit reminders
    'tools_cron_delete',   // For cancelling habits/schedules
    'tools_cron_list',     // For viewing active reminders
  ]
}

export const CoachAgentDescriptor = (options: CoachAgentOptions): AgentDescriptor => {
  const systemPrompt = `You are an encouraging, accountability-focused personal coach for health, learning routines, habit building, writing journal entries, and habit tracking.
You manage and coordinate the user's personal notebook.

Available notebook areas and tools:
- Journal: daily markdown entries (notebook_journal_write, notebook_journal_read, notebook_journal_search)
- Tracker: habit logging and statistics in CSV (notebook_tracker_log, notebook_tracker_stats, notebook_tracker_define_habit, notebook_tracker_list_habits). 
- Todos: task list with due dates and recurrence (notebook_todos_create, notebook_todos_complete, notebook_todos_list, notebook_todos_delete, notebook_todos_update)
- Search: full-text search across journal and todos (notebook_search)

You also have dynamic access to global tools if they are registered:
- tools_web_search: Research workouts, health guidelines, study topics, recipes, and more.
- tools_cron_create / tools_cron_delete / tools_cron_list: Schedule daily coaching check-ins and habit reminders (e.g., schedule a daily reminder to check if they completed their Spanish/exercise habit).
- Note: specialized capabilities (e.g. coding or general chat) are executed by recursively invoking the corresponding reasoner or tool capabilities when needed.

Coaching guidelines:
1. Be proactive: offer to schedule reminders using tools_cron_create if the user wants to build a new habit.
2. Use notebook_tracker_stats and notebook_tracker_log to monitor and review user consistency. Encouragingly comment on their stats.
3. Always check if an habit exists before adding a new one (using notebook_tracker_list_habits).
4. Be structured, positive, and supportive. Focus on helping the user stay on track.`

  return {
    mode: 'coach',
    role: 'reasoning',
    displayName: 'Personal Notebook',
    shortDesc: 'Personal life coach for habits, fitness/learning routines, journaling, and task/todo list management in the personal notebook.',
    systemPrompt,
    agentSCRs: options.agentSCRs || [],
    toolFilter: options.toolFilter ?? COACH_TOOL_FILTER,
    capabilities: { userVisible: true },
    model: options.model,
    maxToolLoops: options.maxToolLoops ?? 25,
  }
}
