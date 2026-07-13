import type { ActorDef, ActorRef, SpanHandle } from '../../../system/index.ts'
import { onLifecycle, onMessage, ask } from '../../../system/index.ts'
import { defineTool } from '../../../system/index.ts'
import type { ToolInvokeMsg, ToolReply } from '../../../types/tools.ts'
import type { HabitDef } from '../types.ts'
import { NotebookChangeTopic } from '../../../types/events.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult } from '../../../types/persistence.ts'

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

type TrackerState = {
  persistenceRef: ActorRef<any> | null
}

type TrackerMsg =
  | ToolInvokeMsg
  | { type: '_done';  replyTo: ActorRef<ToolReply>; toolName: string; result: string; span: SpanHandle | null; userId: string; habit?: string }
  | { type: '_error'; replyTo: ActorRef<ToolReply>; toolName: string; error: string; span: SpanHandle | null }
  | { type: '_persistenceRef'; ref: ActorRef<any> | null }
  | { type: '_void' }

const todayISO = (): string => new Date().toISOString().slice(0, 10)

const csvEscape = (s: string): string =>
  s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s

const logHabit = async (
  persistenceRef: ActorRef<any>,
  habit: string,
  value: number,
  date: string,
  description?: string,
): Promise<string> => {
  const desc = description ? csvEscape(description) : ''
  const line = `${date},${habit},${value},${desc}\n`

  const getRes = await ask<PersistenceMsg, PResult<string>>(persistenceRef, (replyTo) => ({
    type: 'doc.get',
    collection: 'notebook',
    docId: 'tracker/data.csv',
    replyTo,
  }))
  if (!getRes.ok) {
    await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
      type: 'doc.put',
      collection: 'notebook',
      docId: 'tracker/data.csv',
      content: 'date,habit,value,description\n' + line,
      replyTo,
    }))
  } else {
    await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
      type: 'doc.append',
      collection: 'notebook',
      docId: 'tracker/data.csv',
      content: line,
      replyTo,
    }))
  }

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

export const parseCsv = async (persistenceRef: ActorRef<any>): Promise<CsvRow[]> => {
  const res = await ask<PersistenceMsg, PResult<string>>(persistenceRef, (replyTo) => ({
    type: 'doc.get',
    collection: 'notebook',
    docId: 'tracker/data.csv',
    replyTo,
  }))
  const text = res.ok && res.data ? res.data : ''
  if (!text) return []
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length <= 1) return []
  const rows: CsvRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]!)
    if (fields.length >= 3) {
      const val = parseFloat(fields[2]!)
      if (!isNaN(val)) {
        rows.push({
          date: fields[0]!,
          habit: fields[1]!,
          value: val,
          description: fields[3] || undefined,
        })
      }
    }
  }
  return rows
}

const shiftDays = (isoDate: string, delta: number): string => {
  const d = new Date(isoDate)
  d.setDate(d.getDate() + delta)
  return d.toISOString().slice(0, 10)
}

const currentWeekStart = (): string => {
  const d = new Date()
  const day = d.getDay() === 0 ? 6 : d.getDay() - 1
  d.setDate(d.getDate() - day)
  return d.toISOString().slice(0, 10)
}

const currentMonthStart = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

const computeStats = async (persistenceRef: ActorRef<any>, habit: string): Promise<string> => {
  const all = await parseCsv(persistenceRef)
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

const defineHabit = async (
  persistenceRef: ActorRef<any>,
  name: string,
  unit: string,
  dailyTarget?: number,
): Promise<string> => {
  let getResData = ''
  const getRes = await ask<PersistenceMsg, PResult<string>>(persistenceRef, (replyTo) => ({
    type: 'doc.get',
    collection: 'notebook',
    docId: 'tracker/habits.json',
    replyTo,
  }))
  if (getRes.ok && getRes.data) getResData = getRes.data

  const data: { habits: HabitDef[] } = getResData
    ? JSON.parse(getResData)
    : { habits: [] }

  const idx = data.habits.findIndex(h => h.name === name)
  const def: HabitDef = { name, unit, ...(dailyTarget !== undefined ? { dailyTarget } : {}) }
  if (idx >= 0) {
    data.habits[idx] = def
  } else {
    data.habits.push(def)
  }
  await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
    type: 'doc.put',
    collection: 'notebook',
    docId: 'tracker/habits.json',
    content: JSON.stringify(data, null, 2),
    replyTo,
  }))
  return `Habit "${name}" saved (unit: ${unit}${dailyTarget !== undefined ? `, target: ${dailyTarget}` : ''}).`
}

const listHabits = async (persistenceRef: ActorRef<any>): Promise<string> => {
  let getResData = ''
  const getRes = await ask<PersistenceMsg, PResult<string>>(persistenceRef, (replyTo) => ({
    type: 'doc.get',
    collection: 'notebook',
    docId: 'tracker/habits.json',
    replyTo,
  }))
  if (getRes.ok && getRes.data) getResData = getRes.data
  if (!getResData) return 'No habits defined.'
  const data: { habits: HabitDef[] } = JSON.parse(getResData)
  if (data.habits.length === 0) return 'No habits defined.'
  return data.habits.map(h =>
    `- ${h.name} (${h.unit}${h.dailyTarget !== undefined ? `, target: ${h.dailyTarget}` : ''})`
  ).join('\n')
}



export const Tracker = (): ActorDef<TrackerMsg, TrackerState> => ({
  initialState: () => ({ persistenceRef: null }),
  lifecycle: onLifecycle({
    start: (state, context) => {
      context.subscribe(PersistenceProviderTopic, (event) => ({
        type: '_persistenceRef' as const,
        ref: event.ref,
      }))
      return { state }
    }
  }),
  handler: onMessage<TrackerMsg, TrackerState>({
    _persistenceRef: (state, msg) => {
      return { state: { ...state, persistenceRef: msg.ref } }
    },

    _void: (state) => ({ state }),

    invoke: (state, msg, ctx) => {
      if (!state.persistenceRef) {
        msg.replyTo.send({ type: 'toolError', error: 'Persistence not ready' })
        return { state }
      }
      const dl = state.persistenceRef
      let promise: Promise<string>
      let habit: string | undefined
      try {
        if (msg.toolName === trackerLogTool.name) {
          const args = JSON.parse(msg.arguments) as { habit: string; value: number; date?: string; description?: string }
          habit = args.habit
          promise = logHabit(dl, args.habit, args.value, args.date ?? todayISO(), args.description)
        } else if (msg.toolName === trackerStatsTool.name) {
          const args = JSON.parse(msg.arguments) as { habit: string }
          promise = computeStats(dl, args.habit)
        } else if (msg.toolName === trackerDefineHabitTool.name) {
          const args = JSON.parse(msg.arguments) as { name: string; unit: string; dailyTarget?: number }
          habit = args.name
          promise = defineHabit(dl, args.name, args.unit, args.dailyTarget)
        } else if (msg.toolName === trackerListHabitsTool.name) {
          promise = listHabits(dl)
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
