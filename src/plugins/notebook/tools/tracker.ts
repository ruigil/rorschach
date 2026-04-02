import { mkdir } from 'node:fs/promises'
import type { ActorDef, ActorRef } from '../../../system/types.ts'
import { onMessage } from '../../../system/match.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from '../../../types/tools.ts'
import type { HabitDef } from '../types.ts'

// ─── Tool names & schemas ───

export const TRACKER_LOG_TOOL_NAME          = 'tracker_log'
export const TRACKER_STATS_TOOL_NAME        = 'tracker_stats'
export const TRACKER_DEFINE_HABIT_TOOL_NAME = 'tracker_define_habit'
export const TRACKER_LIST_HABITS_TOOL_NAME  = 'tracker_list_habits'

export const TRACKER_LOG_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: TRACKER_LOG_TOOL_NAME,
    description: 'Log a value for a tracked habit.',
    parameters: {
      type: 'object',
      properties: {
        habit: { type: 'string', description: 'Habit name (must exist in habits.json).' },
        value: { type: 'number', description: 'Numeric value to log.' },
        date:  { type: 'string', description: 'Date in YYYY-MM-DD format. Defaults to today.' },
      },
      required: ['habit', 'value'],
    },
  },
}

export const TRACKER_STATS_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: TRACKER_STATS_TOOL_NAME,
    description: 'Get statistics for a tracked habit: daily totals, weekly/monthly averages, current streak, and personal best.',
    parameters: {
      type: 'object',
      properties: {
        habit: { type: 'string', description: 'Habit name.' },
      },
      required: ['habit'],
    },
  },
}

export const TRACKER_DEFINE_HABIT_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: TRACKER_DEFINE_HABIT_TOOL_NAME,
    description: 'Create or update a habit definition.',
    parameters: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: 'Habit name (used as identifier).' },
        unit:        { type: 'string', description: 'Unit of measurement (e.g. "steps", "glasses", "sessions").' },
        dailyTarget: { type: 'number', description: 'Optional daily target value.' },
      },
      required: ['name', 'unit'],
    },
  },
}

export const TRACKER_LIST_HABITS_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: TRACKER_LIST_HABITS_TOOL_NAME,
    description: 'List all defined habits.',
    parameters: { type: 'object', properties: {} },
  },
}

// ─── Internal message type ───

type TrackerMsg =
  | ToolInvokeMsg
  | { type: '_done';  replyTo: ActorRef<ToolReply>; result: string }
  | { type: '_error'; replyTo: ActorRef<ToolReply>; error: string }

// ─── File paths ───

const habitsPath  = (notebookDir: string) => `${notebookDir}/tracker/habits.json`
const csvPath     = (notebookDir: string) => `${notebookDir}/tracker/data.csv`
const trackerDir  = (notebookDir: string) => `${notebookDir}/tracker`

const todayISO = (): string => new Date().toISOString().slice(0, 10)

// ─── Operations ───

const logHabit = async (notebookDir: string, habit: string, value: number, date: string): Promise<string> => {
  await mkdir(trackerDir(notebookDir), { recursive: true })
  const path     = csvPath(notebookDir)
  const file     = Bun.file(path)
  const existing = (await file.exists()) ? await file.text() : 'date,habit,value\n'
  await Bun.write(path, existing + `${date},${habit},${value}\n`)
  return `Logged ${value} for habit "${habit}" on ${date}.`
}

type CsvRow = { date: string; habit: string; value: number }

const parseCsv = async (notebookDir: string): Promise<CsvRow[]> => {
  const file = Bun.file(csvPath(notebookDir))
  if (!(await file.exists())) return []
  const text = await file.text()
  const lines = text.split('\n').slice(1) // skip header
  return lines
    .filter(l => l.trim())
    .map(l => {
      const [date, habit, value] = l.split(',')
      return { date: date!, habit: habit!, value: parseFloat(value!) }
    })
    .filter(r => !isNaN(r.value))
}

const computeStats = async (notebookDir: string, habit: string): Promise<string> => {
  const all  = await parseCsv(notebookDir)
  const rows = all.filter(r => r.habit === habit)
  if (rows.length === 0) return `No data found for habit "${habit}".`

  // Per-day totals
  const byDay = new Map<string, number>()
  for (const r of rows) {
    byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.value)
  }

  const dates  = [...byDay.keys()].sort()
  const values = dates.map(d => byDay.get(d)!)

  // Personal best (max single-day total)
  const personalBest    = Math.max(...values)
  const personalBestDay = dates[values.indexOf(personalBest)]

  // Current streak (consecutive days ending today or most recent)
  const today = todayISO()
  let streak  = 0
  let cursor  = new Date(today)
  while (true) {
    const key = cursor.toISOString().slice(0, 10)
    if (!byDay.has(key)) break
    streak++
    cursor.setDate(cursor.getDate() - 1)
  }

  // Weekly average (last 7 days with entries)
  const recentWeekDates = dates.filter(d => d >= shiftDays(today, -6))
  const weeklyAvg = recentWeekDates.length > 0
    ? (recentWeekDates.reduce((s, d) => s + byDay.get(d)!, 0) / recentWeekDates.length).toFixed(1)
    : 'n/a'

  // Monthly average (last 30 days with entries)
  const recentMonthDates = dates.filter(d => d >= shiftDays(today, -29))
  const monthlyAvg = recentMonthDates.length > 0
    ? (recentMonthDates.reduce((s, d) => s + byDay.get(d)!, 0) / recentMonthDates.length).toFixed(1)
    : 'n/a'

  return [
    `Habit: ${habit}`,
    `Total log entries: ${rows.length} across ${dates.length} days`,
    `Personal best: ${personalBest} (${personalBestDay})`,
    `Current streak: ${streak} day(s)`,
    `Weekly avg (last 7 days): ${weeklyAvg}`,
    `Monthly avg (last 30 days): ${monthlyAvg}`,
    `Recent days: ${dates.slice(-7).map(d => `${d}=${byDay.get(d)}`).join(', ')}`,
  ].join('\n')
}

const shiftDays = (isoDate: string, delta: number): string => {
  const d = new Date(isoDate)
  d.setDate(d.getDate() + delta)
  return d.toISOString().slice(0, 10)
}

const defineHabit = async (notebookDir: string, name: string, unit: string, dailyTarget?: number): Promise<string> => {
  await mkdir(trackerDir(notebookDir), { recursive: true })
  const path  = habitsPath(notebookDir)
  const file  = Bun.file(path)
  const data: { habits: HabitDef[] } = (await file.exists())
    ? JSON.parse(await file.text())
    : { habits: [] }

  const idx = data.habits.findIndex(h => h.name === name)
  const def: HabitDef = { name, unit, ...(dailyTarget !== undefined ? { dailyTarget } : {}) }
  if (idx >= 0) {
    data.habits[idx] = def
  } else {
    data.habits.push(def)
  }
  await Bun.write(path, JSON.stringify(data, null, 2))
  return `Habit "${name}" saved (unit: ${unit}${dailyTarget !== undefined ? `, target: ${dailyTarget}` : ''}).`
}

const listHabits = async (notebookDir: string): Promise<string> => {
  const file = Bun.file(habitsPath(notebookDir))
  if (!(await file.exists())) return 'No habits defined.'
  const data: { habits: HabitDef[] } = JSON.parse(await file.text())
  if (data.habits.length === 0) return 'No habits defined.'
  return data.habits.map(h =>
    `- ${h.name} (${h.unit}${h.dailyTarget !== undefined ? `, target: ${h.dailyTarget}` : ''})`
  ).join('\n')
}

// ─── Actor ───

export const createTrackerActor = (notebookDir: string): ActorDef<TrackerMsg, null> => ({
  handler: onMessage<TrackerMsg, null>({
    invoke: (state, msg, ctx) => {
      let promise: Promise<string>
      try {
        const args = JSON.parse(msg.arguments) as Record<string, unknown>

        if (msg.toolName === TRACKER_LOG_TOOL_NAME) {
          promise = logHabit(notebookDir, args.habit as string, args.value as number, (args.date as string | undefined) ?? todayISO())
        } else if (msg.toolName === TRACKER_STATS_TOOL_NAME) {
          promise = computeStats(notebookDir, args.habit as string)
        } else if (msg.toolName === TRACKER_DEFINE_HABIT_TOOL_NAME) {
          promise = defineHabit(notebookDir, args.name as string, args.unit as string, args.dailyTarget as number | undefined)
        } else if (msg.toolName === TRACKER_LIST_HABITS_TOOL_NAME) {
          promise = listHabits(notebookDir)
        } else {
          promise = Promise.reject(new Error(`Unknown tool: ${msg.toolName}`))
        }
      } catch (e) {
        promise = Promise.reject(e)
      }
      ctx.pipeToSelf(
        promise,
        (result) => ({ type: '_done'  as const, replyTo: msg.replyTo, result }),
        (error)  => ({ type: '_error' as const, replyTo: msg.replyTo, error: String(error) }),
      )
      return { state }
    },

    _done: (state, msg) => {
      msg.replyTo.send({ type: 'toolResult', result: msg.result })
      return { state }
    },

    _error: (state, msg) => {
      msg.replyTo.send({ type: 'toolError', error: msg.error })
      return { state }
    },
  }),

  supervision: { type: 'restart', maxRetries: 5, withinMs: 60_000 },
})
