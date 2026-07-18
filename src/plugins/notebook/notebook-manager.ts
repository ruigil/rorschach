import { onLifecycle, onMessage, ask } from '../../system/index.ts'
import type { ActorDef, ActorRef } from '../../system/index.ts'
import { OutboundUserMessageTopic, HttpWsFrameTopic, type HttpWsFrameEvent } from '../../types/events.ts'
import { NotebookChangeTopic, type NotebookChangeEvent, type Todo } from './types.ts'
import { readTodos, completeTodo, deleteTodo } from './tools/todos.ts'
import { readEntry } from './tools/journal.ts'
import { parseCsv, type CsvRow } from './tools/tracker.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult, type PList } from '../../types/persistence.ts'

export const sortTodos = (todos: Todo[]): Todo[] => {
  const getPriorityWeight = (p?: 'low' | 'medium' | 'high'): number => {
    switch (p) {
      case 'high': return 3
      case 'medium': return 2
      case 'low': return 1
      default: return 0
    }
  }

  return [...todos].sort((a, b) => {
    // 1. Sort by completed status (pending first)
    if (a.done !== b.done) {
      return a.done ? 1 : -1
    }

    // 2. Sort by due date (earliest first, tasks with due dates before tasks without)
    if (a.dueDate && b.dueDate) {
      const cmp = a.dueDate.localeCompare(b.dueDate)
      if (cmp !== 0) return cmp
    } else if (a.dueDate) {
      return -1
    } else if (b.dueDate) {
      return 1
    }

    // 3. Sort by priority (high -> medium -> low -> none)
    const weightA = getPriorityWeight(a.priority)
    const weightB = getPriorityWeight(b.priority)
    if (weightA !== weightB) {
      return weightB - weightA
    }

    // 4. Fallback to createdAt (newest first)
    return b.createdAt - a.createdAt
  })
}

export type NotebookManagerMsg =
  | { type: '_wsFrame'; event: HttpWsFrameEvent }
  | { type: '_dataChanged'; event: NotebookChangeEvent }
  | { type: '_persistenceRef'; ref: ActorRef<any> | null }

type NotebookManagerState = {
  persistenceRef: ActorRef<any> | null
}

const todayISO = (): string => new Date().toISOString().slice(0, 10)

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

function calculateStats(rows: CsvRow[]) {
  if (rows.length === 0) {
    return { streak: 0, personalBest: 0, personalBestDay: undefined, weeklyTotal: 0, weeklyAvg: 0, monthlyTotal: 0, monthlyAvg: 0, count: 0, daysCount: 0 }
  }

  const byDay = new Map<string, number>()
  for (const r of rows) {
    byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.value)
  }

  const dates = [...byDay.keys()].sort()
  const values = dates.map(d => byDay.get(d)!)
  const personalBest = Math.max(...values)
  const personalBestDay = dates[values.indexOf(personalBest)]

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
  const weekDates = dates.filter(d => d >= weekStart)
  const weeklyTotal = weekDates.reduce((s, d) => s + byDay.get(d)!, 0)
  const weeklyAvg = weekDates.length > 0 ? (weeklyTotal / weekDates.length) : 0

  const monthStart = currentMonthStart()
  const monthDates = dates.filter(d => d >= monthStart)
  const monthlyTotal = monthDates.reduce((s, d) => s + byDay.get(d)!, 0)
  const monthlyAvg = monthDates.length > 0 ? (monthlyTotal / monthDates.length) : 0

  return {
    streak,
    personalBest,
    personalBestDay,
    weeklyTotal,
    weeklyAvg: parseFloat(weeklyAvg.toFixed(1)),
    monthlyTotal,
    monthlyAvg: parseFloat(monthlyAvg.toFixed(1)),
    count: rows.length,
    daysCount: dates.length
  }
}



export const NotebookManager = (): ActorDef<NotebookManagerMsg, NotebookManagerState> => ({
  initialState: () => ({ persistenceRef: null }),
  lifecycle: onLifecycle({
    start: (state, ctx) => {
      ctx.subscribe(HttpWsFrameTopic, e => ({ type: '_wsFrame' as const, event: e }))
      ctx.subscribe(NotebookChangeTopic, e => ({ type: '_dataChanged' as const, event: e }))
      ctx.subscribe(PersistenceProviderTopic, (event) => ({
        type: '_persistenceRef' as const,
        ref: event.ref,
      }))
      return { state }
    }
  }),
  handler: onMessage<NotebookManagerMsg, NotebookManagerState>({
    _persistenceRef: (state, msg) => {
      return { state: { ...state, persistenceRef: msg.ref } }
    },

    _wsFrame: (state, msg, ctx) => {
      const { userId, frame } = msg.event
      if (!frame.type.startsWith('notebook.')) return { state }

      const sendFrame = (reply: object) => {
        ctx.publish(OutboundUserMessageTopic, { userId, text: JSON.stringify(reply) })
      }

      if (!state.persistenceRef) {
        sendFrame({ type: 'notebook.error', message: 'Persistence not ready' })
        return { state }
      }
      const dl = state.persistenceRef

      const handle = async () => {
        switch (frame.type) {
          case 'notebook.todos.request': {
            const data = await readTodos(dl)
            const sorted = sortTodos(data.todos)
            sendFrame({ type: 'notebook.todos.list', todos: sorted.slice(0, 10) })
            break
          }
          case 'notebook.todos.complete': {
            const { id } = frame
            await completeTodo(dl, id)
            ctx.publish(NotebookChangeTopic, { type: 'todosUpdated', userId })
            break
          }
          case 'notebook.todos.delete': {
            const { id } = frame
            await deleteTodo(dl, id)
            ctx.publish(NotebookChangeTopic, { type: 'todosUpdated', userId })
            break
          }
          case 'notebook.journal.months.request': {
            const { year, month } = frame
            const prefix = `${year}-${month}`
            const listRes = await ask<PersistenceMsg, PList>(dl, (replyTo) => ({
              type: 'doc.list',
              collection: 'journal',
              prefix,
              replyTo,
            }))
            const days: string[] = []
            if (listRes.ok && listRes.keys) {
              for (const f of listRes.keys) {
                if (f.endsWith('.md')) {
                  days.push(f.slice(0, -3))
                }
              }
            }
            sendFrame({ type: 'notebook.journal.months', year, month, days })
            break
          }
          case 'notebook.journal.entry.request': {
            const content = await readEntry(dl, frame.date)
            sendFrame({ type: 'notebook.journal.entry', date: frame.date, content })
            break
          }
          case 'notebook.tracker.habits.request': {
            const res = await ask<PersistenceMsg, PResult<string>>(dl, (replyTo) => ({
              type: 'doc.get',
              collection: 'notebook',
              docId: 'tracker/habits.json',
              replyTo,
            }))
            const habitsData = (res.ok && res.data) ? JSON.parse(res.data) : { habits: [] }
            sendFrame({ type: 'notebook.tracker.habits', habits: habitsData.habits })
            break
          }
          case 'notebook.tracker.entries.request': {
            const all = await parseCsv(dl)
            const rows = all.filter(r => r.habit === frame.habit)
            sendFrame({ type: 'notebook.tracker.entries', habit: frame.habit, entries: rows })
            break
          }
          case 'notebook.tracker.stats.request': {
            const all = await parseCsv(dl)
            const rows = all.filter(r => r.habit === frame.habit)
            const stats = calculateStats(rows)
            sendFrame({ type: 'notebook.tracker.stats', habit: frame.habit, stats })
            break
          }
        }
      }

      handle().catch(err => sendFrame({ type: 'notebook.error', message: String(err) }))
      return { state }
    },

    _dataChanged: (state, msg, ctx) => {
      const { event } = msg
      const { userId } = event
      const sendFrame = (reply: object) => {
        ctx.publish(OutboundUserMessageTopic, { userId, text: JSON.stringify(reply) })
      }

      if (!state.persistenceRef) return { state }
      const dl = state.persistenceRef

      const reload = async () => {
        if (event.type === 'todosUpdated') {
          const data = await readTodos(dl)
          const sorted = sortTodos(data.todos)
          sendFrame({ type: 'notebook.todos.list', todos: sorted.slice(0, 10) })
        } else if (event.type === 'journalUpdated') {
          const content = await readEntry(dl, event.date)
          sendFrame({ type: 'notebook.journal.entry', date: event.date, content })

          const [year, month] = event.date.split('-')
          if (!year || !month) return
          const prefix = `${year}-${month}`
          const listRes = await ask<PersistenceMsg, PList>(dl, (replyTo) => ({
            type: 'doc.list',
            collection: 'journal',
            prefix,
            replyTo,
          }))
          const days: string[] = []
          if (listRes.ok && listRes.keys) {
            for (const f of listRes.keys) {
              if (f.endsWith('.md')) {
                days.push(f.slice(0, -3))
              }
            }
          }
          sendFrame({ type: 'notebook.journal.months', year, month, days })
        } else if (event.type === 'trackerUpdated') {
          const res = await ask<PersistenceMsg, PResult<string>>(dl, (replyTo) => ({
            type: 'doc.get',
            collection: 'notebook',
            docId: 'tracker/habits.json',
            replyTo,
          }))
          const habitsData = (res.ok && res.data) ? JSON.parse(res.data) : { habits: [] }
          sendFrame({ type: 'notebook.tracker.habits', habits: habitsData.habits })

          const all = await parseCsv(dl)
          const rows = all.filter(r => r.habit === event.habit)
          sendFrame({ type: 'notebook.tracker.entries', habit: event.habit, entries: rows })

          const stats = calculateStats(rows)
          sendFrame({ type: 'notebook.tracker.stats', habit: event.habit, stats })
        }
      }

      reload().catch(err => sendFrame({ type: 'notebook.error', message: String(err) }))
      return { state }
    }
  })
})
