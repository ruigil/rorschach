import { describe, test, expect } from 'bun:test'
import { computeNextDueDate, computeInitialDueDate, completeTodo, readTodos } from '../plugins/notebook/tools/todos.ts'
import { AgentSystem, ask, type ActorRef, staticSource } from '../system/index.ts'
import { MockPersistenceActor } from './mock-persistence.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult } from '../types/persistence.ts'

describe('recurrent todos due date calculation', () => {
  test('computeNextDueDate advances past the completed date for daily cron', () => {
    const nextDue = computeNextDueDate('0 9 * * *', '2026-08-16')
    expect(nextDue).toBe('2026-08-17')
  })

  test('computeNextDueDate advances past the completed date for weekly cron on the same day', () => {
    // 2026-08-17 is Monday
    const nextDue = computeNextDueDate('0 9 * * 1', '2026-08-17')
    expect(nextDue).toBe('2026-08-24')
  })

  test('computeNextDueDate handles multiple days of week (Mon, Wed, Fri)', () => {
    // 2026-08-17 is Monday
    const nextWed = computeNextDueDate('0 9 * * 1,3,5', '2026-08-17')
    expect(nextWed).toBe('2026-08-19')

    // 2026-08-19 is Wednesday
    const nextFri = computeNextDueDate('0 9 * * 1,3,5', '2026-08-19')
    expect(nextFri).toBe('2026-08-21')

    // 2026-08-21 is Friday
    const nextMon = computeNextDueDate('0 9 * * 1,3,5', '2026-08-21')
    expect(nextMon).toBe('2026-08-24')
  })

  test('computeNextDueDate handles monthly recurrence', () => {
    const nextMonth = computeNextDueDate('0 0 1 * *', '2026-08-01')
    expect(nextMonth).toBe('2026-09-01')
  })

  test('computeNextDueDate advances from today if completed todo was overdue', () => {
    const today = new Date().toISOString().slice(0, 10)
    // Completed a task overdue from 2020-01-01
    const nextDue = computeNextDueDate('0 9 * * *', '2020-01-01')
    // Next due should be in the future (after today)
    expect(nextDue > today).toBe(true)
  })

  test('computeNextDueDate handles early completion of future task', () => {
    // Future date e.g. 2099-01-01 (Thursday)
    const nextDue = computeNextDueDate('0 0 * * 4', '2099-01-01')
    expect(nextDue).toBe('2099-01-08')
  })

  test('computeInitialDueDate returns today if today matches schedule', () => {
    const today = new Date().toISOString().slice(0, 10)
    const dailyInitial = computeInitialDueDate('0 9 * * *')
    expect(dailyInitial).toBe(today)
  })
})

describe('completeTodo with recurrence integration', () => {
  test('completing a recurring todo marks old todo done and creates next instance with correct due date', async () => {
    const system = await AgentSystem({ source: staticSource({ plugins: [MockPersistenceActor()] }) })
    let persistenceRef: ActorRef<any> | null = null
    system.subscribe(PersistenceProviderTopic, event => {
      persistenceRef = event.ref
    })

    while (!persistenceRef) {
      await new Promise(r => setTimeout(r, 10))
    }

    const today = new Date().toISOString().slice(0, 10)
    // Seed initial recurring todo due today
    const initialTodos = {
      todos: [
        {
          id: 'rec-1',
          text: 'Daily standup',
          done: false,
          dueDate: today,
          recurrence: '0 9 * * *',
          priority: 'high' as const,
          createdAt: Date.now(),
        }
      ]
    }

    const userId = 'user-1'
    const docId = `${userId}/todo/todos.json`
    await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
      type: 'doc.put',
      collection: 'notebook',
      docId,
      content: JSON.stringify(initialTodos),
      replyTo,
    }))

    const msg = await completeTodo(persistenceRef, userId, 'rec-1')
    expect(msg).toContain('Completed todo: "Daily standup"')
    expect(msg).toContain('Created next recurring instance')

    const data = await readTodos(persistenceRef, userId)
    expect(data.todos).toHaveLength(2)

    const completed = data.todos.find(t => t.id === 'rec-1')
    expect(completed?.done).toBe(true)
    expect(completed?.doneAt).toBeDefined()

    const nextTodo = data.todos.find(t => t.id !== 'rec-1')
    expect(nextTodo).toBeDefined()
    expect(nextTodo?.done).toBe(false)
    expect(nextTodo?.text).toBe('Daily standup')
    expect(nextTodo?.priority).toBe('high')
    expect(nextTodo?.recurrence).toBe('0 9 * * *')
    // Next due date must be strictly after today
    expect(nextTodo?.dueDate && nextTodo.dueDate > today).toBe(true)

    await system.shutdown()
  })
})
