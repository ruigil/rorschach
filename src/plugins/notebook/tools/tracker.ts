import { mkdir } from 'node:fs/promises'
import type { ActorDef, ActorRef, SpanHandle } from '../../../system/index.ts'
import { onMessage } from '../../../system/index.ts'
import { defineTool } from '../../../system/index.ts'
import type { ToolInvokeMsg, ToolReply } from '../../../types/tools.ts'
import type { HabitDef } from '../types.ts'
import { NotebookChangeTopic } from '../../../types/events.ts'

// ─── Tool names & schemas ───

export const trackerLogTool = defineTool('tracker_log', 'Log a numeric value for a tracked habit or any recurring metric (e.g. expenses, weight, steps, mood).', {
  type: 'object',
  properties: {
    habit:       { type: 'string', description: 'Habit name (must exist in habits.json).' },
    value:       { type: 'number', description: 'Numeric value to log.' },
    date:        { type: 'string', description: 'Date in YYYY-MM-DD format. Defaults to today.' },
    description: { type: 'string', description: 'Optional note describing the expense or entry.' },
  },
  required: ['habit', 'value'],
})

export const trackerStatsTool = defineTool('tracker_stats', 'Get statistics for a tracked metric: weekly/monthly totals and averages, current streak, and personal best. Works for habits, expenses, or any numeric series.', {
  type: 'object',
  properties: {
    habit: { type: 'string', description: 'Habit name.' },
  },
  required: ['habit'],
})

export const trackerDefineHabitTool = defineTool('tracker_define_habit', 'Create or update a tracked metric definition (habit, expense category, or any numeric series).', {
  type: 'object',
  properties: {
    name:        { type: 'string', description: 'Habit name (used as identifier).' },
    unit:        { type: 'string', description: 'Unit of measurement (e.g. "steps", "glasses", "sessions").' },
    dailyTarget: { type: 'number', description: 'Optional daily target value.' },
  },
  required: ['name', 'unit'],
})

export const trackerListHabitsTool = defineTool('tracker_list_habits', 'List all defined tracked metrics (habits, expense categories, or any numeric series).', {
  type: 'object',
  properties: {},
})

// ─── Internal message type ───

type TrackerMsg =
  | ToolInvokeMsg
  | { type: '_done';  replyTo: ActorRef<ToolReply>; toolName: string; result: string; span: SpanHandle | null; userId: string; habit?: string }
  | { type: '_error'; replyTo: ActorRef<ToolReply>; toolName: string; error: string; span: SpanHandle | null }

// ─── File paths ───

const habitsPath  = (notebookDir: string) => `${notebookDir}/tracker/habits.json`
const csvPath     = (notebookDir: string) => `${notebookDir}/tracker/data.csv`
const trackerDir  = (notebookDir: string) => `${notebookDir}/tracker`

const todayISO = (): string => new Date().toISOString().slice(0, 10)

// ─── Operations ───

const csvEscape = (s: string): string =>
  s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s

const logHabit = async (notebookDir: string, habit: string, value: number, date: string, description?: string): Promise<string> => {
  await mkdir(trackerDir(notebookDir), { recursive: true })
  const path     = csvPath(notebookDir)
  const file     = Bun.file(path)
  const existing = (await file.exists()) ? await file.text() : 'date,habit,value,description\n'
  const desc     = description ? csvEscape(description) : ''
  await Bun.write(path, existing + `${date},${habit},${value},${desc}\n`)
  const note = description ? ` (${description})` : ''
  return `Logged ${value} for habit "${habit}" on ${date}${note}.`
}

export type CsvRow = { date: string; habit: string; value: number; description?: string }

const parseCsvLine = (line: string): string[] => {
  const fields: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') inQuotes = false
      else field += ch
    } else {
      if (ch === '"') inQuotes = true
      else if (ch === ',') { fields.push(field); field = '' }
      else field += ch
    }
  }
  fields.push(field)
  return fields
}

export const parseCsv = async (notebookDir: string): Promise<CsvRow[]> => {
  const file = Bun.file(csvPath(notebookDir))
  if (!(await file.exists())) return []
  const text = await file.text()
  const lines = text.split('\n').slice(1) // skip header
  return lines
    .filter(l => l.trim())
    .map(l => {
      const [date, habit, value, description] = parseCsvLine(l)
      return { date: date!, habit: habit!, value: parseFloat(value!), description: description || undefined }
    })
    .filter(r => !isNaN(r.value))
}

const shiftDays = (isoDate: string, delta: number): string => {
  const d = new Date(isoDate)
  d.setDate(d.getDate() + delta)
  return d.toISOString().slice(0, 10)
}

const currentWeekStart = (): string => {
  const d = new Date()
  const day = d.getDay() === 0 ? 6 : d.getDay() - 1 // Monday = 0
  d.setDate(d.getDate() - day)
  return d.toISOString().slice(0, 10)
}

const currentMonthStart = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

const computeStats = async (notebookDir: string, habit: string): Promise<string> => {
  const all = await parseCsv(notebookDir)
  const rows = all.filter(r => r.habit === habit)
  if (rows.length === 0) {
    return `No logged entries for habit "${habit}".`
  }

  const byDay = new Map<string, number>()
  for (const r of rows) {
    byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.value)
  }

  const dates = [...byDay.keys()].sort()
  const values = dates.map(d => byDay.get(d)!)
  const personalBest = Math.max(...values)

  const today = todayISO()
  const yesterday = shiftDays(today, -1)
  let start = today
  if (!byDay.has(today) && byDay.has(yesterday)) {
    start = yesterday
  }

  let streak = 0
  if (byDay.has(start)) {
    let cursor = new Date(start)
    while (true) {
      const key = cursor.toISOString().slice(0, 10)
      if (!byDay.has(key)) break
      streak++
      cursor.setDate(cursor.getDate() - 1)
    }
  }

  const weekStart = currentWeekStart()
  const weeklyTotal = dates.filter(d => d >= weekStart).reduce((s, d) => s + byDay.get(d)!, 0)

  const monthStart = currentMonthStart()
  const monthlyTotal = dates.filter(d => d >= monthStart).reduce((s, d) => s + byDay.get(d)!, 0)

  return `Statistics for habit "${habit}":\n` +
    `- Current streak: ${streak} days\n` +
    `- Personal best: ${personalBest} in a single day\n` +
    `- Weekly total (starting Monday): ${weeklyTotal}\n` +
    `- Monthly total: ${monthlyTotal}`
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

export const Tracker = (notebookDir: string): ActorDef<TrackerMsg, null> => ({
  initialState: null,
  handler: onMessage<TrackerMsg, null>({
    invoke: (state, msg, ctx) => {
      let promise: Promise<string>
      let habit: string | undefined
      try {
        if (msg.toolName === trackerLogTool.name) {
          const args = JSON.parse(msg.arguments) as { habit: string; value: number; date?: string; description?: string }
          habit = args.habit
          promise = logHabit(notebookDir, args.habit, args.value, args.date ?? todayISO(), args.description)
        } else if (msg.toolName === trackerStatsTool.name) {
          const args = JSON.parse(msg.arguments) as { habit: string }
          promise = computeStats(notebookDir, args.habit)
        } else if (msg.toolName === trackerDefineHabitTool.name) {
          const args = JSON.parse(msg.arguments) as { name: string; unit: string; dailyTarget?: number }
          habit = args.name
          promise = defineHabit(notebookDir, args.name, args.unit, args.dailyTarget)
        } else if (msg.toolName === trackerListHabitsTool.name) {
          promise = listHabits(notebookDir)
        } else {
          promise = Promise.reject(new Error(`Unknown tool: ${msg.toolName}`))
        }
      } catch (e) {
        promise = Promise.reject(e)
      }
      const parent = ctx.trace.fromHeaders()
      const span: SpanHandle | null = parent
        ? ctx.trace.child(parent.traceId, parent.spanId, msg.toolName, { toolName: msg.toolName })
        : null
      ctx.pipeToSelf(
        promise,
        (result) => ({ type: '_done'  as const, replyTo: msg.replyTo, toolName: msg.toolName, result, span, userId: msg.userId, habit }),
        (error)  => ({ type: '_error' as const, replyTo: msg.replyTo, toolName: msg.toolName, error: String(error), span }),
      )
      return { state }
    },

    _done: (state, msg, ctx) => {
      msg.span?.done()
      msg.replyTo.send({ type: 'toolResult', result: { text: msg.result } })
      if (
        (msg.toolName === trackerLogTool.name || msg.toolName === trackerDefineHabitTool.name) &&
        msg.habit
      ) {
        ctx.publish(NotebookChangeTopic, { type: 'trackerUpdated', userId: msg.userId, habit: msg.habit })
      }
      return { state }
    },

    _error: (state, msg, ctx) => {
      ctx.log.error('tracker error', { tool: msg.toolName, error: msg.error })
      msg.span?.error(msg.error)
      msg.replyTo.send({ type: 'toolError', error: msg.error })
      return { state }
    },
  }),

  supervision: { type: 'restart', maxRetries: 5, withinMs: 60_000 },
})
