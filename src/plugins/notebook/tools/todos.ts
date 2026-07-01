import { mkdir } from 'node:fs/promises'
import { CronExpressionParser } from 'cron-parser'
import type { ActorDef, ActorRef, SpanHandle } from '../../../system/index.ts'
import { onMessage } from '../../../system/index.ts'
import { defineTool } from '../../../system/index.ts'
import type { ToolInvokeMsg, ToolReply } from '../../../types/tools.ts'
import type { Todo } from '../types.ts'
import { NotebookChangeTopic } from '../../../types/events.ts'

// ─── Tool names & schemas ───

export const todosCreateTool = defineTool('todos_create', 'Create a new todo item.', {
  type: 'object',
  properties: {
    text:       { type: 'string', description: 'Task description.' },
    dueDate:    { type: 'string', description: 'Due date in YYYY-MM-DD format (optional).' },
    recurrence: { type: 'string', description: 'Cron expression for recurring tasks, e.g. "0 9 * * 1" for Monday 9am (optional).' },
  },
  required: ['text'],
})

export const todosCompleteTool = defineTool('todos_complete', 'Mark a todo as done. If the todo has a recurrence, a new instance is automatically created for the next occurrence.', {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Todo id.' },
  },
  required: ['id'],
})

export const todosListTool = defineTool('todos_list', 'List todos.', {
  type: 'object',
  properties: {
    filter: {
      type: 'string',
      enum: ['all', 'pending', 'done', 'due_today'],
      description: 'Filter: all, pending (not done), done, or due_today. Defaults to pending.',
    },
  },
})

export const todosDeleteTool = defineTool('todos_delete', 'Delete a todo item permanently.', {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Todo id.' },
  },
  required: ['id'],
})

export const todosUpdateTool = defineTool('todos_update', "Update a todo item's text, due date, or recurrence.", {
  type: 'object',
  properties: {
    id:         { type: 'string', description: 'Todo id.' },
    text:       { type: 'string', description: 'New task description.' },
    dueDate:    { type: 'string', description: 'New due date in YYYY-MM-DD format.' },
    recurrence: { type: 'string', description: 'New cron expression (empty string to remove).' },
  },
  required: ['id'],
})

// ─── Internal message type ───

type TodosMsg =
  | ToolInvokeMsg
  | { type: '_done';  replyTo: ActorRef<ToolReply>; toolName: string; result: string; span: SpanHandle | null; userId: string }
  | { type: '_error'; replyTo: ActorRef<ToolReply>; toolName: string; error: string; span: SpanHandle | null }

// ─── File helpers ───

type TodosFile = { todos: Todo[] }

const todosPath = (notebookDir: string) => `${notebookDir}/todos.json`
const todayISO  = (): string => new Date().toISOString().slice(0, 10)

export const readTodos = async (notebookDir: string): Promise<TodosFile> => {
  const file = Bun.file(todosPath(notebookDir))
  if (!(await file.exists())) return { todos: [] }
  return JSON.parse(await file.text()) as TodosFile
}

const writeTodos = async (notebookDir: string, data: TodosFile): Promise<void> => {
  await mkdir(notebookDir, { recursive: true })
  await Bun.write(todosPath(notebookDir), JSON.stringify(data, null, 2))
}

const formatTodo = (t: Todo): string =>
  `[${t.id.slice(0, 8)}] [${t.done ? 'x' : ' '}] ${t.text}` +
  (t.dueDate ? ` (due: ${t.dueDate})` : '') +
  (t.recurrence ? ` [recurring: ${t.recurrence}]` : '')

// ─── Operations ───

const createTodo = async (
  notebookDir: string,
  text: string,
  dueDate?: string,
  recurrence?: string,
): Promise<string> => {
  const data = await readTodos(notebookDir)
  const todo: Todo = {
    id: crypto.randomUUID(),
    text,
    done: false,
    dueDate,
    recurrence,
    createdAt: Date.now(),
  }
  data.todos.push(todo)
  await writeTodos(notebookDir, data)
  return `Todo created: ${formatTodo(todo)}`
}

export const completeTodo = async (notebookDir: string, id: string): Promise<string> => {
  const data = await readTodos(notebookDir)
  const todo = data.todos.find(t => t.id === id || t.id.startsWith(id))
  if (!todo) throw new Error(`Todo not found: ${id}`)
  if (todo.done) return `Todo already complete: ${formatTodo(todo)}`

  todo.done = true
  todo.doneAt = Date.now()

  let recurMsg = ''
  if (todo.recurrence) {
    try {
      const interval = CronExpressionParser.parse(todo.recurrence)
      const nextDate = interval.next().toDate()
      const nextIso  = nextDate.toISOString().slice(0, 10)
      const recur: Todo = {
        id: crypto.randomUUID(),
        text: todo.text,
        done: false,
        dueDate: nextIso,
        recurrence: todo.recurrence,
        createdAt: Date.now(),
      }
      data.todos.push(recur)
      recurMsg = `\nRecurring task rescheduled for ${nextIso}: ${formatTodo(recur)}`
    } catch (e: any) {
      recurMsg = `\nFailed to reschedule recurring task: ${e.message}`
    }
  }

  await writeTodos(notebookDir, data)
  return `Todo completed: ${formatTodo(todo)}${recurMsg}`
}

const listTodos = async (notebookDir: string, filter: string): Promise<string> => {
  const data = await readTodos(notebookDir)
  let list = data.todos
  const today = todayISO()

  if (filter === 'pending') {
    list = list.filter(t => !t.done)
  } else if (filter === 'done') {
    list = list.filter(t => t.done)
  } else if (filter === 'due_today') {
    list = list.filter(t => !t.done && t.dueDate === today)
  }

  if (list.length === 0) return 'No todos found.'
  return list.map(formatTodo).join('\n')
}

const deleteTodo = async (notebookDir: string, id: string): Promise<string> => {
  const data = await readTodos(notebookDir)
  const idx  = data.todos.findIndex(t => t.id === id || t.id.startsWith(id))
  if (idx === -1) throw new Error(`Todo not found: ${id}`)
  const [removed] = data.todos.splice(idx, 1)
  await writeTodos(notebookDir, data)
  return `Todo deleted: ${formatTodo(removed!)}`
}

const updateTodo = async (
  notebookDir: string,
  id: string,
  text?: string,
  dueDate?: string,
  recurrence?: string,
): Promise<string> => {
  const data = await readTodos(notebookDir)
  const todo = data.todos.find(t => t.id === id || t.id.startsWith(id))
  if (!todo) throw new Error(`Todo not found: ${id}`)

  if (text !== undefined) todo.text = text
  if (dueDate !== undefined) todo.dueDate = dueDate || undefined
  if (recurrence !== undefined) {
    if (recurrence === '') {
      todo.recurrence = undefined
    } else {
      todo.recurrence = recurrence
    }
  }

  await writeTodos(notebookDir, data)
  return `Todo updated: ${formatTodo(todo)}`
}

// ─── Actor ───

export const Todos = (notebookDir: string): ActorDef<TodosMsg, null> => ({
  initialState: null,
  handler: onMessage<TodosMsg, null>({
    invoke: (state, msg, ctx) => {
      let promise: Promise<string>
      try {
        if (msg.toolName === todosCreateTool.name) {
          const args = JSON.parse(msg.arguments) as { text: string; dueDate?: string; recurrence?: string }
          promise = createTodo(notebookDir, args.text, args.dueDate, args.recurrence)
        } else if (msg.toolName === todosCompleteTool.name) {
          const args = JSON.parse(msg.arguments) as { id: string }
          promise = completeTodo(notebookDir, args.id)
        } else if (msg.toolName === todosListTool.name) {
          const args = JSON.parse(msg.arguments) as { filter?: string }
          promise = listTodos(notebookDir, args.filter ?? 'pending')
        } else if (msg.toolName === todosDeleteTool.name) {
          const args = JSON.parse(msg.arguments) as { id: string }
          promise = deleteTodo(notebookDir, args.id)
        } else if (msg.toolName === todosUpdateTool.name) {
          const args = JSON.parse(msg.arguments) as { id: string; text?: string; dueDate?: string; recurrence?: string }
          promise = updateTodo(notebookDir, args.id, args.text, args.dueDate, args.recurrence)
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
        (result) => ({ type: '_done'  as const, replyTo: msg.replyTo, toolName: msg.toolName, result, span, userId: msg.userId }),
        (error)  => ({ type: '_error' as const, replyTo: msg.replyTo, toolName: msg.toolName, error: String(error), span }),
      )
      return { state }
    },

    _done: (state, msg, ctx) => {
      msg.span?.done()
      msg.replyTo.send({ type: 'toolResult', result: { text: msg.result } })
      const isWrite =
        msg.toolName === todosCreateTool.name ||
        msg.toolName === todosCompleteTool.name ||
        msg.toolName === todosDeleteTool.name ||
        msg.toolName === todosUpdateTool.name
      if (isWrite) {
        ctx.publish(NotebookChangeTopic, { type: 'todosUpdated', userId: msg.userId })
      }
      return { state }
    },

    _error: (state, msg, ctx) => {
      ctx.log.error('todos error', { tool: msg.toolName, error: msg.error })
      msg.span?.error(msg.error)
      msg.replyTo.send({ type: 'toolError', error: msg.error })
      return { state }
    },
  }),

  supervision: { type: 'restart', maxRetries: 5, withinMs: 60_000 },
})
