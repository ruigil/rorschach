import { mkdir } from 'node:fs/promises'
import { CronExpressionParser } from 'cron-parser'
import type { ActorDef, ActorRef } from '../../../system/types.ts'
import { onMessage } from '../../../system/match.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from '../../../types/tools.ts'
import type { Todo } from '../types.ts'

// ─── Tool names & schemas ───

export const TODOS_CREATE_TOOL_NAME   = 'todos_create'
export const TODOS_COMPLETE_TOOL_NAME = 'todos_complete'
export const TODOS_LIST_TOOL_NAME     = 'todos_list'
export const TODOS_DELETE_TOOL_NAME   = 'todos_delete'
export const TODOS_UPDATE_TOOL_NAME   = 'todos_update'

export const TODOS_CREATE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: TODOS_CREATE_TOOL_NAME,
    description: 'Create a new todo item.',
    parameters: {
      type: 'object',
      properties: {
        text:       { type: 'string', description: 'Task description.' },
        dueDate:    { type: 'string', description: 'Due date in YYYY-MM-DD format (optional).' },
        recurrence: { type: 'string', description: 'Cron expression for recurring tasks, e.g. "0 9 * * 1" for Monday 9am (optional).' },
      },
      required: ['text'],
    },
  },
}

export const TODOS_COMPLETE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: TODOS_COMPLETE_TOOL_NAME,
    description: 'Mark a todo as done. If the todo has a recurrence, a new instance is automatically created for the next occurrence.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Todo id.' },
      },
      required: ['id'],
    },
  },
}

export const TODOS_LIST_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: TODOS_LIST_TOOL_NAME,
    description: 'List todos.',
    parameters: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['all', 'pending', 'done', 'due_today'],
          description: 'Filter: all, pending (not done), done, or due_today. Defaults to pending.',
        },
      },
    },
  },
}

export const TODOS_DELETE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: TODOS_DELETE_TOOL_NAME,
    description: 'Delete a todo item permanently.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Todo id.' },
      },
      required: ['id'],
    },
  },
}

export const TODOS_UPDATE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: TODOS_UPDATE_TOOL_NAME,
    description: 'Update a todo item\'s text, due date, or recurrence.',
    parameters: {
      type: 'object',
      properties: {
        id:         { type: 'string', description: 'Todo id.' },
        text:       { type: 'string', description: 'New task description.' },
        dueDate:    { type: 'string', description: 'New due date in YYYY-MM-DD format.' },
        recurrence: { type: 'string', description: 'New cron expression (empty string to remove).' },
      },
      required: ['id'],
    },
  },
}

// ─── Internal message type ───

type TodosMsg =
  | ToolInvokeMsg
  | { type: '_done';  replyTo: ActorRef<ToolReply>; toolName: string; result: string }
  | { type: '_error'; replyTo: ActorRef<ToolReply>; toolName: string; error: string }

// ─── File helpers ───

type TodosFile = { todos: Todo[] }

const todosPath = (notebookDir: string) => `${notebookDir}/todos.json`
const todayISO  = (): string => new Date().toISOString().slice(0, 10)

const readTodos = async (notebookDir: string): Promise<TodosFile> => {
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
    createdAt: Date.now(),
    ...(dueDate    ? { dueDate }    : {}),
    ...(recurrence ? { recurrence } : {}),
  }
  data.todos.push(todo)
  await writeTodos(notebookDir, data)
  return `Todo created: ${formatTodo(todo)}`
}

const completeTodo = async (notebookDir: string, id: string): Promise<string> => {
  const data = await readTodos(notebookDir)
  const idx  = data.todos.findIndex(t => t.id === id || t.id.startsWith(id))
  if (idx === -1) return `Todo not found: ${id}`

  const todo = data.todos[idx]!
  data.todos[idx] = { ...todo, done: true, doneAt: Date.now() }

  // If recurring, create next instance
  let nextInfo = ''
  if (todo.recurrence) {
    try {
      const next    = CronExpressionParser.parse(todo.recurrence).next().toDate()
      const nextDue = next.toISOString().slice(0, 10)
      const newTodo: Todo = {
        id: crypto.randomUUID(),
        text: todo.text,
        done: false,
        createdAt: Date.now(),
        dueDate: nextDue,
        recurrence: todo.recurrence,
      }
      data.todos.push(newTodo)
      nextInfo = ` Next occurrence: ${nextDue} (id: ${newTodo.id.slice(0, 8)}).`
    } catch {
      nextInfo = ' (Could not compute next recurrence.)'
    }
  }

  await writeTodos(notebookDir, data)
  return `Todo marked done: "${todo.text}".${nextInfo}`
}

const listTodos = async (notebookDir: string, filter: string): Promise<string> => {
  const data  = await readTodos(notebookDir)
  const today = todayISO()
  let todos   = data.todos

  if (filter === 'pending') {
    todos = todos.filter(t => !t.done)
  } else if (filter === 'done') {
    todos = todos.filter(t => t.done)
  } else if (filter === 'due_today') {
    todos = todos.filter(t => !t.done && t.dueDate === today)
  }

  if (todos.length === 0) return `No todos found (filter: ${filter}).`
  return todos.map(formatTodo).join('\n')
}

const deleteTodo = async (notebookDir: string, id: string): Promise<string> => {
  const data  = await readTodos(notebookDir)
  const before = data.todos.length
  data.todos   = data.todos.filter(t => t.id !== id && !t.id.startsWith(id))
  if (data.todos.length === before) return `Todo not found: ${id}`
  await writeTodos(notebookDir, data)
  return `Todo deleted: ${id}`
}

const updateTodo = async (
  notebookDir: string,
  id: string,
  text?: string,
  dueDate?: string,
  recurrence?: string,
): Promise<string> => {
  const data = await readTodos(notebookDir)
  const idx  = data.todos.findIndex(t => t.id === id || t.id.startsWith(id))
  if (idx === -1) return `Todo not found: ${id}`

  const todo = data.todos[idx]!
  data.todos[idx] = {
    ...todo,
    ...(text       !== undefined ? { text }       : {}),
    ...(dueDate    !== undefined ? { dueDate }    : {}),
    ...(recurrence !== undefined ? { recurrence: recurrence || undefined } : {}),
  }
  await writeTodos(notebookDir, data)
  return `Todo updated: ${formatTodo(data.todos[idx]!)}`
}

// ─── Actor ───

export const createTodosActor = (notebookDir: string): ActorDef<TodosMsg, null> => ({
  handler: onMessage<TodosMsg, null>({
    invoke: (state, msg, ctx) => {
      let promise: Promise<string>
      try {
        const args = JSON.parse(msg.arguments) as Record<string, unknown>

        if (msg.toolName === TODOS_CREATE_TOOL_NAME) {
          ctx.log.info('todos: create', { text: args.text })
          promise = createTodo(notebookDir, args.text as string, args.dueDate as string | undefined, args.recurrence as string | undefined)
        } else if (msg.toolName === TODOS_COMPLETE_TOOL_NAME) {
          ctx.log.info('todos: complete', { id: args.id })
          promise = completeTodo(notebookDir, args.id as string)
        } else if (msg.toolName === TODOS_LIST_TOOL_NAME) {
          ctx.log.info('todos: list', { filter: args.filter })
          promise = listTodos(notebookDir, (args.filter as string | undefined) ?? 'pending')
        } else if (msg.toolName === TODOS_DELETE_TOOL_NAME) {
          ctx.log.info('todos: delete', { id: args.id })
          promise = deleteTodo(notebookDir, args.id as string)
        } else if (msg.toolName === TODOS_UPDATE_TOOL_NAME) {
          ctx.log.info('todos: update', { id: args.id })
          promise = updateTodo(notebookDir, args.id as string, args.text as string | undefined, args.dueDate as string | undefined, args.recurrence as string | undefined)
        } else {
          promise = Promise.reject(new Error(`Unknown tool: ${msg.toolName}`))
        }
      } catch (e) {
        promise = Promise.reject(e)
      }
      ctx.pipeToSelf(
        promise,
        (result) => ({ type: '_done'  as const, replyTo: msg.replyTo, toolName: msg.toolName, result }),
        (error)  => ({ type: '_error' as const, replyTo: msg.replyTo, toolName: msg.toolName, error: String(error) }),
      )
      return { state }
    },

    _done: (state, msg) => {
      msg.replyTo.send({ type: 'toolResult', result: msg.result })
      return { state }
    },

    _error: (state, msg, ctx) => {
      ctx.log.error('todos error', { tool: msg.toolName, error: msg.error })
      msg.replyTo.send({ type: 'toolError', error: msg.error })
      return { state }
    },
  }),

  supervision: { type: 'restart', maxRetries: 5, withinMs: 60_000 },
})
