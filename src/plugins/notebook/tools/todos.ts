import { CronExpressionParser } from 'cron-parser'
import type { ActorDef, ActorRef, SpanHandle } from '../../../system/index.ts'
import { onLifecycle, onMessage, ask } from '../../../system/index.ts'
import { defineTool } from '../../../system/index.ts'
import type { ToolInvokeMsg, ToolReply } from '../../../types/tools.ts'
import type { Todo } from '../types.ts'
import { NotebookChangeTopic } from '../types.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult } from '../../../types/persistence.ts'

export const todosCreateTool = defineTool('todos_create', 'Create a new todo item.', {
  type: 'object',
  properties: {
    text:       { type: 'string', description: 'Task description.' },
    dueDate:    { type: 'string', description: 'Due date in YYYY-MM-DD format (optional).' },
    recurrence: { type: 'string', description: 'Cron expression for recurring tasks, e.g. "0 9 * * 1" for Monday 9am (optional).' },
    priority:   { type: 'string', enum: ['low', 'medium', 'high'], description: 'Priority of the todo (low, medium, or high) (optional).' },
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

export const todosUpdateTool = defineTool('todos_update', "Update a todo item's text, due date, recurrence, or priority.", {
  type: 'object',
  properties: {
    id:         { type: 'string', description: 'Todo id.' },
    text:       { type: 'string', description: 'New task description.' },
    dueDate:    { type: 'string', description: 'New due date in YYYY-MM-DD format.' },
    recurrence: { type: 'string', description: 'New cron expression (empty string to remove).' },
    priority:   { type: 'string', enum: ['low', 'medium', 'high', ''], description: 'New priority (low, medium, high, or empty string to remove).' },
  },
  required: ['id'],
})

type TodosState = {
  persistenceRef: ActorRef<any> | null
}

type TodosMsg =
  | ToolInvokeMsg
  | { type: '_done';  replyTo: ActorRef<ToolReply>; toolName: string; result: string; span: SpanHandle | null; userId: string }
  | { type: '_error'; replyTo: ActorRef<ToolReply>; toolName: string; error: string; span: SpanHandle | null }
  | { type: '_persistenceRef'; ref: ActorRef<any> | null }
  | { type: '_void' }

type TodosFile = { todos: Todo[] }

const todayISO  = (): string => new Date().toISOString().slice(0, 10)

export const readTodos = async (persistenceRef: ActorRef<any>, userId: string): Promise<TodosFile> => {
  const res = await ask<PersistenceMsg, PResult<string>>(persistenceRef, (replyTo) => ({
    type: 'doc.get',
    collection: 'notebook',
    docId: `${userId}/todo/todos.json`,
    replyTo,
  }))
  if (res.ok && res.data) {
    try {
      return JSON.parse(res.data) as TodosFile
    } catch {}
  }
  return { todos: [] }
}

const writeTodos = async (persistenceRef: ActorRef<any>, userId: string, data: TodosFile): Promise<void> => {
  await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
    type: 'doc.put',
    collection: 'notebook',
    docId: `${userId}/todo/todos.json`,
    content: JSON.stringify(data, null, 2),
    replyTo,
  }))
}

const formatTodo = (t: Todo): string =>
  `[${t.id.slice(0, 8)}] [${t.done ? 'x' : ' '}] ${t.text}` +
  (t.priority ? ` [priority: ${t.priority}]` : '') +
  (t.dueDate ? ` (due: ${t.dueDate})` : '') +
  (t.recurrence ? ` (recurring: ${t.recurrence})` : '')

const createTodo = async (
  persistenceRef: ActorRef<any>,
  userId: string,
  text: string,
  dueDate?: string,
  recurrence?: string,
  priority?: 'low' | 'medium' | 'high',
): Promise<string> => {
  const data = await readTodos(persistenceRef, userId)
  const todo: Todo = {
    id: crypto.randomUUID(),
    text: text.trim(),
    done: false,
    createdAt: Date.now(),
  }
  if (dueDate) todo.dueDate = dueDate.trim()
  if (recurrence) {
    try {
      CronExpressionParser.parse(recurrence)
      todo.recurrence = recurrence.trim()
    } catch {
      throw new Error(`Invalid recurrence cron expression: "${recurrence}"`)
    }
  }
  if (priority) todo.priority = priority
  data.todos.push(todo)
  await writeTodos(persistenceRef, userId, data)
  return `Todo created: ${formatTodo(todo)}`
}

export const completeTodo = async (persistenceRef: ActorRef<any>, userId: string, id: string): Promise<string> => {
  const data = await readTodos(persistenceRef, userId)
  const todo = data.todos.find(t => t.id === id || t.id.startsWith(id))
  if (!todo) throw new Error(`Todo "${id}" not found.`)
  if (todo.done) return `Todo is already completed.`

  todo.done = true
  todo.doneAt = Date.now()

  let msg = `Completed: ${todo.text}`
  if (todo.recurrence) {
    try {
      const parsed = CronExpressionParser.parse(todo.recurrence)
      const nextDate = parsed.next().toDate()
      const nextDateStr = nextDate.toISOString().slice(0, 10)
      const recurred: Todo = {
        id: crypto.randomUUID(),
        text: todo.text,
        done: false,
        createdAt: Date.now(),
        dueDate: nextDateStr,
        recurrence: todo.recurrence,
        priority: todo.priority,
      }
      data.todos.push(recurred)
      msg += `\nRecurring todo scheduled for next occurrence on ${nextDateStr}.`
    } catch (e) {
      msg += `\nFailed to schedule recurrence: ${String(e)}`
    }
  }

  await writeTodos(persistenceRef, userId, data)
  return msg
}

const listTodos = async (persistenceRef: ActorRef<any>, userId: string, filter: string): Promise<string> => {
  const data = await readTodos(persistenceRef, userId)
  let list = data.todos
  const today = todayISO()
  if (filter === 'pending') {
    list = list.filter(t => !t.done)
  } else if (filter === 'done') {
    list = list.filter(t => t.done)
  } else if (filter === 'due_today') {
    list = list.filter(t => !t.done && t.dueDate === today)
  }
  if (list.length === 0) return `No todos found matching filter "${filter}".`
  return list.map(formatTodo).join('\n')
}

export const deleteTodo = async (persistenceRef: ActorRef<any>, userId: string, id: string): Promise<string> => {
  const data = await readTodos(persistenceRef, userId)
  const index = data.todos.findIndex(t => t.id === id || t.id.startsWith(id))
  if (index === -1) throw new Error(`Todo "${id}" not found.`)
  const [deleted] = data.todos.splice(index, 1)
  await writeTodos(persistenceRef, userId, data)
  return `Todo deleted permanently: ${deleted!.text}`
}

const updateTodo = async (
  persistenceRef: ActorRef<any>,
  userId: string,
  id: string,
  text?: string,
  dueDate?: string,
  recurrence?: string,
  priority?: 'low' | 'medium' | 'high' | '',
): Promise<string> => {
  const data = await readTodos(persistenceRef, userId)
  const todo = data.todos.find(t => t.id === id || t.id.startsWith(id))
  if (!todo) throw new Error(`Todo "${id}" not found.`)

  if (text !== undefined) todo.text = text.trim()
  if (dueDate !== undefined) {
    const clean = dueDate.trim()
    todo.dueDate = clean === '' ? undefined : clean
  }
  if (recurrence !== undefined) {
    const clean = recurrence.trim()
    if (clean === '') {
      todo.recurrence = undefined
    } else {
      try {
        CronExpressionParser.parse(clean)
        todo.recurrence = clean
      } catch {
        throw new Error(`Invalid recurrence cron expression: "${clean}"`)
      }
    }
  }
  if (priority !== undefined) {
    const clean = priority.trim() as 'low' | 'medium' | 'high' | ''
    if (clean === '') {
      todo.priority = undefined
    } else {
      todo.priority = clean
    }
  }

  await writeTodos(persistenceRef, userId, data)
  return `Todo updated: ${formatTodo(todo)}`
}



export const Todos = (): ActorDef<TodosMsg, TodosState> => ({
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
  handler: onMessage<TodosMsg, TodosState>({
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
      try {
        if (msg.toolName === todosCreateTool.name) {
          const args = JSON.parse(msg.arguments) as { text: string; dueDate?: string; recurrence?: string; priority?: 'low' | 'medium' | 'high' }
          promise = createTodo(dl, msg.userId, args.text, args.dueDate, args.recurrence, args.priority)
        } else if (msg.toolName === todosCompleteTool.name) {
          const args = JSON.parse(msg.arguments) as { id: string }
          promise = completeTodo(dl, msg.userId, args.id)
        } else if (msg.toolName === todosListTool.name) {
          const args = JSON.parse(msg.arguments) as { filter?: string }
          promise = listTodos(dl, msg.userId, args.filter ?? 'pending')
        } else if (msg.toolName === todosDeleteTool.name) {
          const args = JSON.parse(msg.arguments) as { id: string }
          promise = deleteTodo(dl, msg.userId, args.id)
        } else if (msg.toolName === todosUpdateTool.name) {
          const args = JSON.parse(msg.arguments) as { id: string; text?: string; dueDate?: string; recurrence?: string; priority?: 'low' | 'medium' | 'high' | '' }
          promise = updateTodo(dl, msg.userId, args.id, args.text, args.dueDate, args.recurrence, args.priority)
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
