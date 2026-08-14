import type { ActorDef, ActorRef, SpanHandle } from '../../../system/index.ts'
import { onLifecycle, onMessage, ask } from '../../../system/index.ts'
import { defineTool } from '../../../system/index.ts'
import type { SCRInvokeMsg, SCRReply } from '../../../types/scr.ts'
import type { HabitDef } from '../types.ts'
import { NotebookChangeTopic } from '../types.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult } from '../../../types/persistence.ts'

export const trackerLogTool = defineTool('notebook_tracker_log', 'Log a numeric value for a tracked habit or any recurring metric (e.g. expenses, weight, steps, mood).', {
  type: 'object',
  properties: {
    habit:       { type: 'string', description: 'Habit name (must exist in habits.json).' },
    value:       { type: 'number', description: 'Numeric value to log.' },
    date:        { type: 'string', description: 'Date in YYYY-MM-DD format. Defaults to today.' },
    description: { type: 'string', description: 'Optional note describing the expense or entry.' },
  },
  required: ['habit', 'value'],
})

export const trackerStatsTool = defineTool('notebook_tracker_stats', 'Get statistics for a tracked metric: weekly/monthly totals and averages, current streak, and personal best. Works for habits, expenses, or any numeric series.', {
  type: 'object',
  properties: {
    habit: { type: 'string', description: 'Habit name.' },
  },
  required: ['habit'],
})

export const trackerDefineHabitTool = defineTool('notebook_tracker_define_habit', 'Create or update a tracked metric definition (habit, expense category, or any numeric series).', {
  type: 'object',
  properties: {
    name:        { type: 'string', description: 'Habit name (used as identifier).' },
    unit:        { type: 'string', description: 'Unit of measurement (e.g. "steps", "glasses", "sessions").' },
    dailyTarget: { type: 'number', description: 'Optional daily target value.' },
  },
  required: ['name', 'unit'],
})

export const trackerListHabitsTool = defineTool('notebook_tracker_list_habits', 'List all defined tracked metrics (habits, expense categories, or any numeric series).', {
  type: 'object',
  properties: {},
})

type TrackerState = {
  persistenceRef: ActorRef<any> | null
}

type TrackerMsg =
  | SCRInvokeMsg
  | { type: '_done';  replyTo: ActorRef<SCRReply>; urn: string; result: string; span: SpanHandle | null; userId: string; habit?: string }
  | { type: '_error'; replyTo: ActorRef<SCRReply>; urn: string; error: string; span: SpanHandle | null }
  | { type: '_persistenceRef'; ref: ActorRef<any> | null }
  | { type: '_void' }

const todayISO = (): string => new Date().toISOString().slice(0, 10)

const csvEscape = (s: string): string =>
  s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s

const logHabit = async (
  persistenceRef: ActorRef<any>,
  userId: string,
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
    docId: `${userId}/tracker/data.csv`,
    replyTo,
  }))
  if (!getRes.ok) {
    await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
      type: 'doc.put',
      collection: 'notebook',
      docId: `${userId}/tracker/data.csv`,
      content: 'date,habit,value,description\n' + line,
      replyTo,
    }))
  } else {
    await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
      type: 'doc.append',
      collection: 'notebook',
      docId: `${userId}/tracker/data.csv`,
      content: line,
      replyTo,
    }))
  }

  const note = description ? ` (${description})` : ''
  return `Logged ${value} for habit "${habit}" on ${date}${note}.`
}

export type CsvRow = { date: string; habit: string; value: number; description?: string }

const parseCsvLine = (line: string): string[] => {
  const result: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++ }
      else { inQuotes = !inQuotes }
    } else if (ch === ',' && !inQuotes) {
      result.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  result.push(cur)
  return result
}

export const parseCsv = (csv: string): CsvRow[] => {
  const lines = csv.trim().split('\n').filter(Boolean)
  if (lines.length <= 1) return []
  return lines.slice(1).map((l) => {
    const [date, habit, valStr, desc] = parseCsvLine(l)
    return {
      date: (date ?? '').trim(),
      habit: (habit ?? '').trim(),
      value: parseFloat(valStr ?? '0') || 0,
      description: desc?.trim(),
    }
  })
}

const getHabitDef = async (persistenceRef: ActorRef<any>, userId: string, habitName: string): Promise<HabitDef | null> => {
  const res = await ask<PersistenceMsg, PResult<string>>(persistenceRef, (replyTo) => ({
    type: 'doc.get',
    collection: 'notebook',
    docId: `${userId}/tracker/habits.json`,
    replyTo,
  }))
  if (!res.ok || !res.data) return null
  try {
    const defs: HabitDef[] = JSON.parse(res.data)
    return defs.find((h) => h.name.toLowerCase() === habitName.toLowerCase()) ?? null
  } catch {
    return null
  }
}

const daysAgoISO = (n: number): string => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

export const readCsv = async (persistenceRef: ActorRef<any>, userId: string): Promise<CsvRow[]> => {
  const getRes = await ask<PersistenceMsg, PResult<string>>(persistenceRef, (replyTo) => ({
    type: 'doc.get',
    collection: 'notebook',
    docId: `${userId}/tracker/data.csv`,
    replyTo,
  }))
  if (!getRes.ok || !getRes.data) {
    return []
  }
  return parseCsv(getRes.data)
}

const computeStats = async (persistenceRef: ActorRef<any>, userId: string, habit: string): Promise<string> => {
  const rows = (await readCsv(persistenceRef, userId)).filter((r) => r.habit.toLowerCase() === habit.toLowerCase())
  if (rows.length === 0) {
    return `No entries found for "${habit}".`
  }

  const habitDef = await getHabitDef(persistenceRef, userId, habit)
  const unit = habitDef?.unit ?? 'units'
  const target = habitDef?.dailyTarget

  const since7  = daysAgoISO(7)
  const since30 = daysAgoISO(30)

  const rows7  = rows.filter((r) => r.date >= since7)
  const rows30 = rows.filter((r) => r.date >= since30)

  const sum7   = rows7.reduce((acc, r) => acc + r.value, 0)
  const sum30  = rows30.reduce((acc, r) => acc + r.value, 0)
  const allSum = rows.reduce((acc, r) => acc + r.value, 0)

  const avg7  = (sum7 / 7).toFixed(1)
  const avg30 = (sum30 / 30).toFixed(1)

  const byDate = new Map<string, number>()
  for (const r of rows) {
    byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.value)
  }

  const qualifies = (val: number): boolean => target !== undefined ? val >= target : val > 0

  let currentStreak = 0
  let checkDate = new Date()
  while (true) {
    const iso = checkDate.toISOString().slice(0, 10)
    const val = byDate.get(iso) ?? 0
    if (qualifies(val)) {
      currentStreak++
      checkDate.setDate(checkDate.getDate() - 1)
    } else {
      if (currentStreak === 0 && iso === todayISO()) {
        checkDate.setDate(checkDate.getDate() - 1)
        continue
      }
      break
    }
  }

  let bestStreak = 0
  let tempStreak = 0
  const sortedDates = [...byDate.keys()].sort()
  let prevDate: Date | null = null

  for (const dStr of sortedDates) {
    const val = byDate.get(dStr) ?? 0
    const curDate = new Date(dStr)
    if (qualifies(val)) {
      if (prevDate) {
        const diffDays = Math.round((curDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24))
        if (diffDays === 1) {
          tempStreak++
        } else {
          tempStreak = 1
        }
      } else {
        tempStreak = 1
      }
      prevDate = curDate
      if (tempStreak > bestStreak) bestStreak = tempStreak
    } else {
      tempStreak = 0
      prevDate = null
    }
  }

  const lines = [
    `**Statistics for "${habit}" (${unit})**`,
    target !== undefined ? `Daily Target: ${target} ${unit}` : null,
    `Total (all time): ${allSum} ${unit} across ${rows.length} entries`,
    `Last 7 days:  total ${sum7} ${unit} (avg ${avg7}/day)`,
    `Last 30 days: total ${sum30} ${unit} (avg ${avg30}/day)`,
    `Current streak: ${currentStreak} day(s)`,
    `Best streak:    ${bestStreak} day(s)`,
  ].filter(Boolean)

  return lines.join('\n')
}

const defineHabit = async (
  persistenceRef: ActorRef<any>,
  userId: string,
  name: string,
  unit: string,
  dailyTarget?: number,
): Promise<string> => {
  const getRes = await ask<PersistenceMsg, PResult<string>>(persistenceRef, (replyTo) => ({
    type: 'doc.get',
    collection: 'notebook',
    docId: `${userId}/tracker/habits.json`,
    replyTo,
  }))

  let habits: HabitDef[] = []
  if (getRes.ok && getRes.data) {
    try { habits = JSON.parse(getRes.data) } catch { habits = [] }
  }

  const existingIdx = habits.findIndex((h) => h.name.toLowerCase() === name.toLowerCase())
  const newDef: HabitDef = { name, unit, dailyTarget }

  if (existingIdx >= 0) {
    habits[existingIdx] = newDef
  } else {
    habits.push(newDef)
  }

  await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
    type: 'doc.put',
    collection: 'notebook',
    docId: `${userId}/tracker/habits.json`,
    content: JSON.stringify(habits, null, 2),
    replyTo,
  }))

  const targetStr = dailyTarget !== undefined ? ` (target: ${dailyTarget} ${unit}/day)` : ''
  return `Habit "${name}" defined with unit "${unit}"${targetStr}.`
}

const listHabits = async (persistenceRef: ActorRef<any>, userId: string): Promise<string> => {
  const getRes = await ask<PersistenceMsg, PResult<string>>(persistenceRef, (replyTo) => ({
    type: 'doc.get',
    collection: 'notebook',
    docId: `${userId}/tracker/habits.json`,
    replyTo,
  }))

  if (!getRes.ok || !getRes.data) {
    return 'No habits defined yet. Use tracker_define_habit to create one.'
  }

  try {
    const habits: HabitDef[] = JSON.parse(getRes.data)
    if (habits.length === 0) return 'No habits defined yet.'
    const lines = habits.map((h) => {
      const targetStr = h.dailyTarget !== undefined ? `, target: ${h.dailyTarget} ${h.unit}/day` : ''
      return `- **${h.name}** (${h.unit}${targetStr})`
    })
    return lines.join('\n')
  } catch {
    return 'Failed to parse habits.json.'
  }
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
        msg.replyTo.send({ type: 'error', error: 'Persistence not ready' })
        return { state }
      }
      const dl = state.persistenceRef
      const userId = ctx.request.userId
      let promise: Promise<string>
      let habit: string | undefined
      try {
        const isLog = msg.urn.endsWith('tracker_log') || msg.urn.endsWith('trackerLog') || msg.urn.endsWith(trackerLogTool.name)
        const isStats = msg.urn.endsWith('tracker_stats') || msg.urn.endsWith('trackerStats') || msg.urn.endsWith(trackerStatsTool.name)
        const isDefine = msg.urn.endsWith('define_habit') || msg.urn.endsWith('tracker_define_habit') || msg.urn.endsWith(trackerDefineHabitTool.name)
        const isList = msg.urn.endsWith('list_habits') || msg.urn.endsWith('tracker_list_habits') || msg.urn.endsWith(trackerListHabitsTool.name)

        const rawInput = typeof msg.input === 'string' ? JSON.parse(msg.input) : (msg.input ?? {})
        if (isLog) {
          const args = rawInput as { habit: string; value: number; date?: string; description?: string }
          habit = args.habit
          promise = logHabit(dl, userId, args.habit, args.value, args.date ?? todayISO(), args.description)
        } else if (isStats) {
          const args = rawInput as { habit: string }
          promise = computeStats(dl, userId, args.habit)
        } else if (isDefine) {
          const args = rawInput as { name: string; unit: string; dailyTarget?: number }
          habit = args.name
          promise = defineHabit(dl, userId, args.name, args.unit, args.dailyTarget)
        } else if (isList) {
          promise = listHabits(dl, userId)
        } else {
          promise = Promise.reject(new Error(`Unknown tool: ${msg.urn}`))
        }
      } catch (e) {
        promise = Promise.reject(e)
      }
      const span = ctx.trace.span(msg.urn, { urn: msg.urn })
      ctx.pipeToSelf(
        promise,
        (result) => ({ type: '_done'  as const, replyTo: msg.replyTo, urn: msg.urn, result, span, userId, habit }),
        (error)  => ({ type: '_error' as const, replyTo: msg.replyTo, urn: msg.urn, error: String(error), span }),
      )
      return { state }
    },

    _done: (state, msg, ctx) => {
      msg.span?.done()
      msg.replyTo.send({ type: 'result', output: { text: msg.result } })
      const isLog = msg.urn.endsWith('tracker_log') || msg.urn.endsWith('trackerLog') || msg.urn.endsWith(trackerLogTool.name)
      const isDefine = msg.urn.endsWith('define_habit') || msg.urn.endsWith('tracker_define_habit') || msg.urn.endsWith(trackerDefineHabitTool.name)
      if ((isLog || isDefine) && msg.habit) {
        ctx.publish(NotebookChangeTopic, { type: 'trackerUpdated', userId: msg.userId, habit: msg.habit })
      }
      return { state }
    },

    _error: (state, msg, ctx) => {
      ctx.log.error('tracker error', { urn: msg.urn, error: msg.error })
      msg.span?.error(msg.error)
      msg.replyTo.send({ type: 'error', error: msg.error })
      return { state }
    },
  }),

  supervision: { type: 'restart', maxRetries: 5, withinMs: 60_000 },
})
