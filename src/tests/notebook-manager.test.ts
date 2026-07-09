import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentSystem } from '../system/index.ts'
import { OutboundUserMessageTopic, HttpWsFrameTopic, NotebookChangeTopic } from '../types/events.ts'
import { NotebookManager } from '../plugins/notebook/notebook-manager.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const makeDir = async (): Promise<string> => {
  const dir = join(tmpdir(), `rorschach-notebook-manager-${crypto.randomUUID()}`)
  tempDirs.push(dir)
  await mkdir(dir, { recursive: true })
  return dir
}

describe('NotebookManager WebSocket integration', () => {
  test('handles todos requests, journal requests, tracker requests, and change events', async () => {
    const dir = await makeDir()

    // 1. Set up initial files on disk
    // Todos
    await writeFile(join(dir, 'todos.json'), JSON.stringify({
      todos: [
        { id: 't1', text: 'Buy milk', done: false, createdAt: Date.now() },
        { id: 't2', text: 'Clean room', done: true, createdAt: Date.now() - 1000 }
      ]
    }))

    // Journal
    await mkdir(join(dir, 'journal', '2026', '07'), { recursive: true })
    await writeFile(join(dir, 'journal', '2026', '07', '01.md'), '## 10:00\n\nCompleted websocket refactoring.')

    // Tracker habits
    await mkdir(join(dir, 'tracker'), { recursive: true })
    await writeFile(join(dir, 'tracker', 'habits.json'), JSON.stringify({
      habits: [
        { name: 'Water', unit: 'ml', dailyTarget: 2000 }
      ]
    }))

    // Tracker entries
    await writeFile(join(dir, 'tracker', 'data.csv'), 'date,habit,value,description\n2026-07-01,Water,500,glass 1\n2026-07-01,Water,750,glass 2\n')

    // 2. Initialize Agent System
    const system = await AgentSystem()
    const messages: Array<{ userId: string; text: string }> = []
    system.subscribe(OutboundUserMessageTopic, event => {
      const e = event as { userId: string; text: string }
      messages.push(e)
    })

    // Spawn the NotebookManager slot actor
    system.spawn('notebook-manager', NotebookManager())

    const waitMessages = async (count: number, timeout = 1000) => {
      const start = Date.now()
      while (messages.length < count && Date.now() - start < timeout) {
        await new Promise(r => setTimeout(r, 10))
      }
    }

    // ─── Test 1: notebook.todos.request ───
    messages.length = 0
    system.publish(HttpWsFrameTopic, {
      clientId: 'c1',
      userId: 'u1',
      roles: [],
      frame: { type: 'notebook.todos.request' }
    })
    await waitMessages(1)
    expect(messages).toHaveLength(1)
    const todosRes = JSON.parse(messages[0]!.text)
    expect(todosRes.type).toBe('notebookTodosList')
    expect(todosRes.todos).toHaveLength(2)
    expect(todosRes.todos[0].text).toBe('Buy milk') // Sorted by done: false first

    // ─── Test 2: notebook.journal.months.request ───
    messages.length = 0
    system.publish(HttpWsFrameTopic, {
      clientId: 'c1',
      userId: 'u1',
      roles: [],
      frame: { type: 'notebook.journal.months.request', year: '2026', month: '07' }
    })
    await waitMessages(1)
    expect(messages).toHaveLength(1)
    const monthsRes = JSON.parse(messages[0]!.text)
    expect(monthsRes.type).toBe('notebookJournalMonths')
    expect(monthsRes.days).toEqual(['01'])

    // ─── Test 3: notebook.journal.entry.request ───
    messages.length = 0
    system.publish(HttpWsFrameTopic, {
      clientId: 'c1',
      userId: 'u1',
      roles: [],
      frame: { type: 'notebook.journal.entry.request', date: '2026-07-01' }
    })
    await waitMessages(1)
    expect(messages).toHaveLength(1)
    const entryRes = JSON.parse(messages[0]!.text)
    expect(entryRes.type).toBe('notebookJournalEntry')
    expect(entryRes.content).toContain('Completed websocket refactoring.')

    // ─── Test 4: notebook.tracker.habits.request ───
    messages.length = 0
    system.publish(HttpWsFrameTopic, {
      clientId: 'c1',
      userId: 'u1',
      roles: [],
      frame: { type: 'notebook.tracker.habits.request' }
    })
    await waitMessages(1)
    expect(messages).toHaveLength(1)
    const habitsRes = JSON.parse(messages[0]!.text)
    expect(habitsRes.type).toBe('notebookTrackerHabits')
    expect(habitsRes.habits).toEqual([{ name: 'Water', unit: 'ml', dailyTarget: 2000 }])

    // ─── Test 5: notebook.tracker.entries.request ───
    messages.length = 0
    system.publish(HttpWsFrameTopic, {
      clientId: 'c1',
      userId: 'u1',
      roles: [],
      frame: { type: 'notebook.tracker.entries.request', habit: 'Water' }
    })
    await waitMessages(1)
    expect(messages).toHaveLength(1)
    const trackerEntriesRes = JSON.parse(messages[0]!.text)
    expect(trackerEntriesRes.type).toBe('notebookTrackerEntries')
    expect(trackerEntriesRes.entries).toHaveLength(2)
    expect(trackerEntriesRes.entries[0].value).toBe(500)

    // ─── Test 6: notebook.tracker.stats.request ───
    messages.length = 0
    system.publish(HttpWsFrameTopic, {
      clientId: 'c1',
      userId: 'u1',
      roles: [],
      frame: { type: 'notebook.tracker.stats.request', habit: 'Water' }
    })
    await waitMessages(1)
    expect(messages).toHaveLength(1)
    const statsRes = JSON.parse(messages[0]!.text)
    expect(statsRes.type).toBe('notebookTrackerStats')
    expect(statsRes.stats.personalBest).toBe(1250) // 500 + 750 on 2026-07-01
    expect(statsRes.stats.count).toBe(2)

    // ─── Test 6.5: notebook.todos.complete ───
    messages.length = 0
    system.publish(HttpWsFrameTopic, {
      clientId: 'c1',
      userId: 'u1',
      roles: [],
      frame: { type: 'notebook.todos.complete', id: 't1' }
    })
    await waitMessages(1)
    expect(messages).toHaveLength(1)
    const completeRes = JSON.parse(messages[0]!.text)
    expect(completeRes.type).toBe('notebookTodosList')
    expect(completeRes.todos.find((t: any) => t.id === 't1').done).toBe(true)

    // ─── Test 7: NotebookChangeTopic auto-reload push ───
    messages.length = 0
    // Simulate updating todo on disk and publishing NotebookChangeTopic
    await writeFile(join(dir, 'todos.json'), JSON.stringify({
      todos: [
        { id: 't1', text: 'Buy milk', done: true, createdAt: Date.now() }, // Mark as done
        { id: 't2', text: 'Clean room', done: true, createdAt: Date.now() - 1000 }
      ]
    }))

    system.publish(NotebookChangeTopic, {
      type: 'todosUpdated',
      userId: 'u1'
    })
    await waitMessages(1)
    expect(messages).toHaveLength(1)
    const pushRes = JSON.parse(messages[0]!.text)
    expect(pushRes.type).toBe('notebookTodosList')
    expect(pushRes.todos[0].done).toBe(true)

    await system.shutdown()
  })
})
