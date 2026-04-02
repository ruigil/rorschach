import type { ActorDef } from '../../system/types.ts'
import { emit } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { WsBroadcastTopic } from '../../types/ws.ts'
import type { Todo, TodoReminderMsg } from './types.ts'

// ─── State ───

export type TodoReminderState = {
  notebookDir: string
}

// ─── Helpers ───

const readTodos = async (notebookDir: string): Promise<Todo[]> => {
  const file = Bun.file(`${notebookDir}/todos.json`)
  if (!(await file.exists())) return []
  const data = JSON.parse(await file.text()) as { todos: Todo[] }
  return data.todos
}

const scheduleReminders = (
  todos: Todo[],
  ctx: { timers: { startSingleTimer: (key: string, msg: TodoReminderMsg, delayMs: number) => void } },
): void => {
  const now = Date.now()
  for (const todo of todos) {
    if (!todo.done && todo.dueDate) {
      // Remind at 9am on the due date
      const due = new Date(todo.dueDate)
      due.setHours(9, 0, 0, 0)
      const delay = due.getTime() - now
      if (delay > 0) {
        ctx.timers.startSingleTimer(todo.id, { type: '_tick', todoId: todo.id, text: todo.text }, delay)
      }
    }
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

// ─── Actor ───

export const createTodoReminderActor = (notebookDir: string): ActorDef<TodoReminderMsg, TodoReminderState> => ({
  lifecycle: onLifecycle({
    start: async (state, ctx) => {
      const todos = await readTodos(notebookDir).catch(() => [])
      scheduleReminders(todos, ctx)
      ctx.timers.startPeriodicTimer('scan', { type: '_scan' }, MS_PER_DAY)
      ctx.log.info('todo-reminder started')
      return { state }
    },
  }),

  handler: onMessage<TodoReminderMsg, TodoReminderState>({
    _tick: (state, msg) => ({
      state,
      events: [emit(WsBroadcastTopic, { text: JSON.stringify({ type: 'notification', text: `Reminder: ${msg.text}` }) })],
    }),

    _scan: (state, _msg, ctx) => {
      ctx.pipeToSelf(
        readTodos(state.notebookDir),
        (todos): TodoReminderMsg => {
          scheduleReminders(todos, ctx)
          return { type: '_scan' }
        },
        (): TodoReminderMsg => ({ type: '_scan' }),
      )
      return { state }
    },
  }),

  supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
})

export const INITIAL_TODO_REMINDER_STATE = (notebookDir: string): TodoReminderState => ({
  notebookDir,
})
