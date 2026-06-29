import type { RouteRegistration } from '../../types/routes.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import type { Identity } from '../../types/identity.ts'
import { readTodos } from './tools/todos.ts'
import { readEntry } from './tools/journal.ts'
import { parseCsv } from './tools/tracker.ts'
import { readdir } from 'node:fs/promises'

// ─── Config Schema Sections ──────────────────────────────────────────────────

export const notebookSchema: ConfigSchemaSection = {
  id: 'notebook.config',
  title: 'Notebook',
  subtitle: 'notebook · journal, todos, and tracker',
  tab: 'notebook',
  configKey: '',
  routeId: 'config.notebook',
  schema: {
    type: 'object',
    properties: {
      notebookDir: { type: 'string', default: 'workspace/notebook', 'x-ui': { label: 'Notebook directory' } },
      agent: {
        type: 'object',
        properties: {
          model: { type: 'string', 'x-ui': { widget: 'model-select', label: 'Agent model' } },
          maxToolLoops: { type: 'number', default: 10, minimum: 1, maximum: 50 },
        },
      },
    },
  },
}

export const notebookSchemas = [notebookSchema]

// ─── Helper Functions ────────────────────────────────────────────────────────

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const requireSession = (identity: Identity | null): Response | null =>
  identity ? null : json({ error: 'Unauthorized' }, 401)

const todayISO = (): string => new Date().toISOString().slice(0, 10)

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

// ─── API Routes ──────────────────────────────────────────────────────────────

export const buildNotebookRoutes = (
  notebookDir: string,
): RouteRegistration[] => [
  {
    id: 'notebook.todos',
    method: 'GET',
    path: '/notebook/todos',
    handler: async (_req, _url, identity) => {
      const unauthorized = requireSession(identity)
      if (unauthorized) return unauthorized

      const data = await readTodos(notebookDir)
      const sorted = [...data.todos].sort((a, b) => {
        if (a.done !== b.done) {
          return a.done ? 1 : -1
        }
        return b.createdAt - a.createdAt
      })
      return json(sorted.slice(0, 10))
    },
  },
  {
    id: 'notebook.journal.months',
    method: 'GET',
    path: '/notebook/journal/months',
    handler: async (_req, url, identity) => {
      const unauthorized = requireSession(identity)
      if (unauthorized) return unauthorized

      const year = url.searchParams.get('year')
      const month = url.searchParams.get('month')
      if (!year || !month) {
        return json({ error: 'Missing year or month' }, 400)
      }

      const journalMonthDir = `${notebookDir}/journal/${year}/${month}`
      const days: string[] = []
      try {
        const files = await readdir(journalMonthDir)
        for (const f of files) {
          if (f.endsWith('.md')) {
            days.push(f.slice(0, -3)) // Remove .md
          }
        }
      } catch {
        // Directory doesn't exist
      }
      return json(days)
    },
  },
  {
    id: 'notebook.journal.entry',
    method: 'GET',
    path: '/notebook/journal/entry',
    handler: async (_req, url, identity) => {
      const unauthorized = requireSession(identity)
      if (unauthorized) return unauthorized

      const date = url.searchParams.get('date')
      if (!date) {
        return json({ error: 'Missing date' }, 400)
      }

      const content = await readEntry(notebookDir, date)
      return json({ content })
    },
  },
  {
    id: 'notebook.tracker.habits',
    method: 'GET',
    path: '/notebook/tracker/habits',
    handler: async (_req, _url, identity) => {
      const unauthorized = requireSession(identity)
      if (unauthorized) return unauthorized

      const path = `${notebookDir}/tracker/habits.json`
      const file = Bun.file(path)
      const habitsData = (await file.exists()) ? JSON.parse(await file.text()) : { habits: [] }
      return json(habitsData.habits)
    },
  },
  {
    id: 'notebook.tracker.entries',
    method: 'GET',
    path: '/notebook/tracker/entries',
    handler: async (_req, url, identity) => {
      const unauthorized = requireSession(identity)
      if (unauthorized) return unauthorized

      const habit = url.searchParams.get('habit')
      if (!habit) {
        return json({ error: 'Missing habit' }, 400)
      }

      const all = await parseCsv(notebookDir)
      const rows = all.filter(r => r.habit === habit)
      return json(rows)
    },
  },
  {
    id: 'notebook.tracker.stats',
    method: 'GET',
    path: '/notebook/tracker/stats',
    handler: async (_req, url, identity) => {
      const unauthorized = requireSession(identity)
      if (unauthorized) return unauthorized

      const habit = url.searchParams.get('habit')
      if (!habit) {
        return json({ error: 'Missing habit' }, 400)
      }

      const all = await parseCsv(notebookDir)
      const rows = all.filter(r => r.habit === habit)
      if (rows.length === 0) {
        return json({ streak: 0, personalBest: 0, weeklyTotal: 0, monthlyTotal: 0, weeklyAvg: 0, monthlyAvg: 0, count: 0, daysCount: 0 })
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

      return json({
        streak,
        personalBest,
        personalBestDay,
        weeklyTotal,
        weeklyAvg: parseFloat(weeklyAvg.toFixed(1)),
        monthlyTotal,
        monthlyAvg: parseFloat(monthlyAvg.toFixed(1)),
        count: rows.length,
        daysCount: dates.length
      })
    },
  },
]
