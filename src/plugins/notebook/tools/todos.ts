import { CronExpressionParser } from 'cron-parser'
import type { ActorDef, ActorRef, SpanHandle } from '../../../system/index.ts'
import { onLifecycle, onMessage, ask } from '../../../system/index.ts'
import { defineTool } from '../../../system/index.ts'
import type { SCRInvokeMsg, SCRReply } from '../../../types/scr.ts'
import type { Todo } from '../types.ts'
import { NotebookChangeTopic } from '../types.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult } from '../../../types/persistence.ts'

export const todosCreateTool = defineTool('notebook_todos_create', 'Create a new todo item.', {
  type: 'object',
  properties: {
    text:       { type: 'string', description: 'Task description.' },
    dueDate:    { type: 'string', description: 'Due date in YYYY-MM-DD format (optional).' },
    recurrence: { type: 'string', description: 'Cron expression for recurring tasks, e.g. "0 9 * * 1" for Monday 9am (optional).' },
    priority:   { type: 'string', enum: ['low', 'medium', 'high'], description: 'Priority of the todo (low, medium, or high) (optional).' },
  },
  required: ['text'],
})

export const todosCompleteTool = defineTool('notebook_todos_complete', 'Mark a todo as done. If the todo has a recurrence, a new instance is automatically created for the next occurrence.', {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Todo id.' },
  },
  required: ['id'],
})

export const todosListTool = defineTool('notebook_todos_list', 'List todos.', {
  type: 'object',
  properties: {
    filter: {
      type: 'string',
      enum: ['all', 'pending', 'done', 'due_today'],
      description: 'Filter: all, pending (not done), done, or due_today. Defaults to pending.',
    },
  },
})

export const todosDeleteTool = defineTool('notebook_todos_delete', 'Delete a todo item permanently.', {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Todo id.' },
  },
  required: ['id'],
})

export const todosUpdateTool = defineTool('notebook_todos_update', "Update a todo item's text, due date, recurrence, or priority.", {
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
  | SCRInvokeMsg
  | { type: '_done';  replyTo: ActorRef<SCRReply>; urn: string; result: string; span: SpanHandle | null; userId: string }
  | { type: '_error'; replyTo: ActorRef<SCRReply>; urn: string; error: string; span: SpanHandle | null }
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

const formatTodo = (t: Todo): string => {
  const status = t.done ? '[x]' : '[ ]'
  const due = t.dueDate ? ` (due: ${t.dueDate})` : ''
  const rec = t.recurrence ? ` [recurring: ${t.recurrence}]` : ''
  const pri = t.priority ? ` [priority: ${t.priority}]` : ''
  return `${status} ${t.id}: ${t.text}${due}${rec}${pri}`
}

export const computeNextDueDate = (cronExpr: string, fromDateISO?: string): string => {
  const today = todayISO()
  const safeFrom = fromDateISO?.trim()
  const isValidISO = safeFrom && /^\d{4}-\d{2}-\d{2}$/.test(safeFrom)
  const baseISO = (isValidISO && safeFrom > today) ? safeFrom : today
  const base = new Date(`${baseISO}T23:59:59.999Z`)
  const interval = CronExpressionParser.parse(cronExpr, { currentDate: base, tz: 'UTC' })
  return interval.next().toDate().toISOString().slice(0, 10)
}

export const computeInitialDueDate = (cronExpr: string, fromDateISO?: string): string => {
  const today = todayISO()
  const safeFrom = fromDateISO?.trim()
  const isValidISO = safeFrom && /^\d{4}-\d{2}-\d{2}$/.test(safeFrom)
  const baseISO = isValidISO ? safeFrom : today
  const startOfDay = new Date(`${baseISO}T00:00:00.000Z`)
  const justBefore = new Date(startOfDay.getTime() - 1)
  const interval = CronExpressionParser.parse(cronExpr, { currentDate: justBefore, tz: 'UTC' })
  return interval.next().toDate().toISOString().slice(0, 10)
}

const createTodo = async (
  persistenceRef: ActorRef<any>,
  userId: string,
  text: string,
  dueDate?: string,
  recurrence?: string,
  priority?: 'low' | 'medium' | 'high',
): Promise<string> => {
  if (recurrence) {
    try {
      CronExpressionParser.parse(recurrence)
    } catch (e) {
      throw new Error(`Invalid cron expression "${recurrence}": ${String(e)}`)
    }
  }

  const data = await readTodos(persistenceRef, userId)
  const id = crypto.randomUUID()
  const calculatedDue = (!dueDate && recurrence) ? computeInitialDueDate(recurrence) : dueDate
  const todo: Todo = {
    id,
    text: text.trim(),
    done: false,
    createdAt: Date.now(),
    ...(calculatedDue ? { dueDate: calculatedDue.trim() } : {}),
    ...(recurrence ? { recurrence: recurrence.trim() } : {}),
    ...(priority ? { priority } : {}),
  }
  data.todos.push(todo)
  await writeTodos(persistenceRef, userId, data)
  return `Todo created: ${formatTodo(todo)}`
}

export const completeTodo = async (persistenceRef: ActorRef<any>, userId: string, id: string): Promise<string> => {
  const data = await readTodos(persistenceRef, userId)
  const todo = data.todos.find((t) => t.id === id || t.id.startsWith(id))
  if (!todo) throw new Error(`Todo with id "${id}" not found.`)
  if (todo.done) return `Todo "${todo.text}" was already completed.`

  todo.done = true
  todo.doneAt = Date.now()

  let msg = `Completed todo: "${todo.text}".`

  if (todo.recurrence) {
    try {
      const nextDue = computeNextDueDate(todo.recurrence, todo.dueDate)
      const nextTodo: Todo = {
        id: crypto.randomUUID(),
        text: todo.text,
        done: false,
        createdAt: Date.now(),
        dueDate: nextDue,
        recurrence: todo.recurrence,
        ...(todo.priority ? { priority: todo.priority } : {}),
      }
      data.todos.push(nextTodo)
      msg += ` Created next recurring instance due ${nextDue}: id=${nextTodo.id}`
    } catch (e) {
      msg += ` (Failed to create next recurrence: ${String(e)})`
    }
  }

  await writeTodos(persistenceRef, userId, data)
  return msg
}

const listTodos = async (persistenceRef: ActorRef<any>, userId: string, filter = 'pending'): Promise<string> => {
  const data = await readTodos(persistenceRef, userId)
  const today = todayISO()

  let filtered = data.todos
  if (filter === 'pending') {
    filtered = filtered.filter((t) => !t.done)
  } else if (filter === 'done') {
    filtered = filtered.filter((t) => t.done)
  } else if (filter === 'due_today') {
    filtered = filtered.filter((t) => !t.done && t.dueDate && t.dueDate <= today)
  }

  if (filtered.length === 0) {
    return `No todos found matching filter "${filter}".`
  }

  return filtered.map(formatTodo).join('\n')
}

export const deleteTodo = async (persistenceRef: ActorRef<any>, userId: string, id: string): Promise<string> => {
  const data = await readTodos(persistenceRef, userId)
  const idx = data.todos.findIndex((t) => t.id === id || t.id.startsWith(id))
  if (idx === -1) throw new Error(`Todo with id "${id}" not found.`)
  const [removed] = data.todos.splice(idx, 1)
  await writeTodos(persistenceRef, userId, data)
  return `Deleted todo: "${removed?.text}".`
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
  const todo = data.todos.find((t) => t.id === id)
  if (!todo) throw new Error(`Todo with id "${id}" not found.`)

  if (text !== undefined) todo.text = text
  if (dueDate !== undefined) {
    if (dueDate === '') {
      delete todo.dueDate
    } else {
      todo.dueDate = dueDate
    }
  }
  if (recurrence !== undefined) {
    if (recurrence === '') {
      delete todo.recurrence
    } else {
      try {
        CronExpressionParser.parse(recurrence)
      } catch (e) {
        throw new Error(`Invalid cron expression "${recurrence}": ${String(e)}`)
      }
      todo.recurrence = recurrence
    }
  }
  if (priority !== undefined) {
    if (priority === '') {
      delete todo.priority
    } else {
      todo.priority = priority
    }
  }

  await writeTodos(persistenceRef, userId, data)
  return `Updated todo: ${formatTodo(todo)}`
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
        msg.replyTo.send({ type: 'error', error: 'Persistence not ready' })
        return { state }
      }
      const dl = state.persistenceRef
      const userId = ctx.request.userId
      let promise: Promise<string>
      try {
        const isCreate = msg.urn.endsWith('todos_create') || msg.urn.endsWith('todosCreate') || msg.urn.endsWith(todosCreateTool.name)
        const isComplete = msg.urn.endsWith('todos_complete') || msg.urn.endsWith('todosComplete') || msg.urn.endsWith(todosCompleteTool.name)
        const isList = msg.urn.endsWith('todos_list') || msg.urn.endsWith('todosList') || msg.urn.endsWith(todosListTool.name)
        const isDelete = msg.urn.endsWith('todos_delete') || msg.urn.endsWith('todosDelete') || msg.urn.endsWith(todosDeleteTool.name)
        const isUpdate = msg.urn.endsWith('todos_update') || msg.urn.endsWith('todosUpdate') || msg.urn.endsWith(todosUpdateTool.name)

        const rawInput = typeof msg.input === 'string' ? JSON.parse(msg.input) : (msg.input ?? {})
        if (isCreate) {
          const args = rawInput as { text: string; dueDate?: string; recurrence?: string; priority?: 'low' | 'medium' | 'high' }
          promise = createTodo(dl, userId, args.text, args.dueDate, args.recurrence, args.priority)
        } else if (isComplete) {
          const args = rawInput as { id: string }
          promise = completeTodo(dl, userId, args.id)
        } else if (isList) {
          const args = rawInput as { filter?: string }
          promise = listTodos(dl, userId, args.filter ?? 'pending')
        } else if (isDelete) {
          const args = rawInput as { id: string }
          promise = deleteTodo(dl, userId, args.id)
        } else if (isUpdate) {
          const args = rawInput as { id: string; text?: string; dueDate?: string; recurrence?: string; priority?: 'low' | 'medium' | 'high' | '' }
          promise = updateTodo(dl, userId, args.id, args.text, args.dueDate, args.recurrence, args.priority)
        } else {
          promise = Promise.reject(new Error(`Unknown tool: ${msg.urn}`))
        }
      } catch (e) {
        promise = Promise.reject(e)
      }
      const span = ctx.trace.span(msg.urn, { urn: msg.urn })
      ctx.pipeToSelf(
        promise,
        (result) => ({ type: '_done'  as const, replyTo: msg.replyTo, urn: msg.urn, result, span, userId }),
        (error)  => ({ type: '_error' as const, replyTo: msg.replyTo, urn: msg.urn, error: String(error), span }),
      )
      return { state }
    },

    _done: (state, msg, ctx) => {
      msg.span?.done()
      msg.replyTo.send({ type: 'result', output: { text: msg.result } })
      const isWrite =
        msg.urn.endsWith('todos_create') ||
        msg.urn.endsWith('todosCreate') ||
        msg.urn.endsWith(todosCreateTool.name) ||
        msg.urn.endsWith('todos_complete') ||
        msg.urn.endsWith('todosComplete') ||
        msg.urn.endsWith(todosCompleteTool.name) ||
        msg.urn.endsWith('todos_delete') ||
        msg.urn.endsWith('todosDelete') ||
        msg.urn.endsWith(todosDeleteTool.name) ||
        msg.urn.endsWith('todos_update') ||
        msg.urn.endsWith('todosUpdate') ||
        msg.urn.endsWith(todosUpdateTool.name)
      if (isWrite) {
        ctx.publish(NotebookChangeTopic, { type: 'todosUpdated', userId: msg.userId })
      }
      return { state }
    },

    _error: (state, msg, ctx) => {
      ctx.log.error('todos error', { urn: msg.urn, error: msg.error })
      msg.span?.error(msg.error)
      msg.replyTo.send({ type: 'error', error: msg.error })
      return { state }
    },
  }),

  supervision: { type: 'restart', maxRetries: 5, withinMs: 60_000 },
})
