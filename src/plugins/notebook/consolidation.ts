import type { ActorDef, ActorRef, MessageHandler } from '../../system/types.ts'
import { emit } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { WsBroadcastTopic } from '../../types/ws.ts'
import type { ToolCollection, ToolEntry, ToolFilter, ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import { applyToolFilter, ToolRegistrationTopic } from '../../types/tools.ts'
import { ask } from '../../system/ask.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  LlmProviderReply,
  ModelInfo,
  Tool,
  ToolCall,
} from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { NotebookConsolidationMsg, Todo } from './types.ts'

// ─── Options ───

export type NotebookConsolidationOptions = {
  model:         string
  intervalMs:    number
  notebookDir:   string
  maxToolLoops?: number
}

// ─── State ───

type PendingBatch = {
  remaining:          number
  results:            Array<{ toolCallId: string; toolName: string; content: string }>
  messagesAtCall:     ApiMessage[]
  assistantToolCalls: ToolCall[]
}

export type NotebookConsolidationState = {
  llmRef:        ActorRef<LlmProviderMsg> | null
  modelInfo:     ModelInfo | null
  tools:         ToolCollection
  requestId:     string | null
  turnMessages:  ApiMessage[] | null
  accumulated:   string
  pendingBatch:  PendingBatch | null
  toolLoopCount: number
}

// ─── Prompt builder (async — called via pipeToSelf) ───

const buildPrompt = async (notebookDir: string): Promise<ApiMessage[]> => {
  const today = new Date().toISOString().slice(0, 10)
  const parts: string[] = [`Today is ${today}. Consolidate the following notebook content.`]

  // Last 7 journal entries
  const journalDir = `${notebookDir}/journal`
  try {
    const entries: string[] = []
    const glob = new Bun.Glob('**/*.md')
    for await (const relPath of glob.scan({ cwd: journalDir })) {
      entries.push(relPath)
    }
    const recent = entries.sort().slice(-7)
    if (recent.length > 0) {
      parts.push('\n## Journal (last 7 entries)')
      for (const relPath of recent) {
        const text = await Bun.file(`${journalDir}/${relPath}`).text().catch(() => '')
        if (text) parts.push(`\n### ${relPath}\n${text}`)
      }
    }
  } catch { /* journal dir may not exist */ }

  // Todos
  try {
    const file = Bun.file(`${notebookDir}/todos.json`)
    if (await file.exists()) {
      const data: { todos: Todo[] } = JSON.parse(await file.text())
      const week = Date.now() - 7 * 24 * 60 * 60 * 1000
      const pending  = data.todos.filter(t => !t.done)
      const finished = data.todos.filter(t => t.done && (t.doneAt ?? 0) > week)
      if (pending.length > 0 || finished.length > 0) {
        parts.push('\n## Todos')
        if (pending.length > 0) {
          parts.push('Pending: ' + pending.map(t => `"${t.text}"${t.dueDate ? ` (due ${t.dueDate})` : ''}`).join(', '))
        }
        if (finished.length > 0) {
          parts.push('Completed this week: ' + finished.map(t => `"${t.text}"`).join(', '))
        }
      }
    }
  } catch { /* ignore */ }

  // Tracker
  try {
    const file = Bun.file(`${notebookDir}/tracker/data.csv`)
    if (await file.exists()) {
      const text  = await file.text()
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - 7)
      const cutoffDate = cutoff.toISOString().slice(0, 10)
      const rows = text.split('\n').slice(1).filter(l => {
        const d = l.split(',')[0] ?? ''
        return l.trim() && d >= cutoffDate
      })
      if (rows.length > 0) {
        parts.push('\n## Tracker (last 7 days)\n' + rows.join('\n'))
      }
    }
  } catch { /* ignore */ }

  const systemPrompt =
    `You are the notebook consolidation agent. Your job:\n` +
    `1. Write a weekly summary to ${notebookDir}/summaries/weekly/ using the write tool.\n` +
    `   Compute the ISO week, e.g. use bash: date +%G-W%V\n` +
    `2. Store key insights in the knowledge graph using kgraph_write (Cypher MERGE statements).\n` +
    `   Focus on habits, completed goals, patterns, and notable events.\n` +
    `3. Be concise — synthesize, don't repeat raw data.`

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: parts.join('\n') },
  ]
}

// ─── Shared tool handlers ───

const toolRegistered = (
  state: NotebookConsolidationState,
  msg: Extract<NotebookConsolidationMsg, { type: '_toolRegistered' }>,
): { state: NotebookConsolidationState } => ({
  state: { ...state, tools: { ...state.tools, [msg.name]: { schema: msg.schema, ref: msg.ref } } },
})

const toolUnregistered = (
  state: NotebookConsolidationState,
  msg: Extract<NotebookConsolidationMsg, { type: '_toolUnregistered' }>,
): { state: NotebookConsolidationState } => {
  const { [msg.name]: _, ...rest } = state.tools
  return { state: { ...state, tools: rest } }
}

const llmProviderChanged = (
  state: NotebookConsolidationState,
  msg: Extract<NotebookConsolidationMsg, { type: '_llmProvider' }>,
  context: Parameters<MessageHandler<NotebookConsolidationMsg, NotebookConsolidationState>>[2],
): { state: NotebookConsolidationState } => {
  if (msg.ref) {
    context.pipeToSelf(
      ask<LlmProviderMsg, ModelInfo | null>(msg.ref, (replyTo) => ({ type: 'fetchModelInfo', model: '', replyTo })),
      (info): NotebookConsolidationMsg => ({ type: '_modelInfo', info }),
      ():    NotebookConsolidationMsg => ({ type: '_modelInfo', info: null }),
    )
  }
  return { state: { ...state, llmRef: msg.ref } }
}

// ─── Actor ───

const CONSOLIDATION_TOOL_FILTER: ToolFilter = { allow: ['kgraph_write', 'kgraph_query', 'bash', 'write', 'read'] }

export const createNotebookConsolidationActor = (
  options: NotebookConsolidationOptions,
): ActorDef<NotebookConsolidationMsg, NotebookConsolidationState> => {
  const { model, intervalMs, notebookDir, maxToolLoops = 10 } = options

  let awaitingLlmHandler: MessageHandler<NotebookConsolidationMsg, NotebookConsolidationState>
  let toolLoopHandler:    MessageHandler<NotebookConsolidationMsg, NotebookConsolidationState>

  // ─── Handler: idle ───

  const idleHandler: MessageHandler<NotebookConsolidationMsg, NotebookConsolidationState> = onMessage({
    _consolidate: (state, _msg, context) => {
      if (!state.llmRef) return { state }

      // Build prompt asynchronously; when done, send _ready to self
      context.pipeToSelf(
        buildPrompt(notebookDir).then((messages): NotebookConsolidationMsg => ({
          type: '_ready',
          requestId: crypto.randomUUID(),
          messages,
        })),
        (msg): NotebookConsolidationMsg => msg,
        (): NotebookConsolidationMsg => ({ type: '_consolidate' }),
      )

      return { state, become: awaitingLlmHandler }
    },

    _llmProvider:      llmProviderChanged,
    _modelInfo:        (state, msg) => ({ state: { ...state, modelInfo: msg.info } }),
    _toolRegistered:   toolRegistered,
    _toolUnregistered: toolUnregistered,
  })

  // ─── Handler: awaitingLlm — waiting for prompt build or LLM response ───

  awaitingLlmHandler = onMessage<NotebookConsolidationMsg, NotebookConsolidationState>({
    _consolidate: (state) => ({ state }),  // skip — already running

    _ready: (state, msg, context) => {
      if (!state.llmRef) return { state, become: idleHandler }

      const toolSchemas = Object.values(state.tools).map((e: ToolEntry) => e.schema as Tool)
      state.llmRef.send({
        type: 'stream',
        requestId: msg.requestId,
        model,
        messages: msg.messages,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state: {
          ...state,
          requestId:    msg.requestId,
          turnMessages: msg.messages,
          accumulated:  '',
          toolLoopCount: 0,
        },
      }
    },

    llmChunk: (state, msg) => {
      if (msg.requestId !== state.requestId) return { state }
      return { state: { ...state, accumulated: state.accumulated + msg.text } }
    },

    llmReasoningChunk: (state) => ({ state }),

    llmToolCalls: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }

      const assistantToolCalls: ToolCall[] = msg.calls.map(c => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments },
      }))

      const batch: PendingBatch = {
        remaining: msg.calls.length,
        results: [],
        messagesAtCall: state.turnMessages!,
        assistantToolCalls,
      }

      for (const call of msg.calls) {
        const entry = state.tools[call.name]
        if (!entry) { context.log.warn('notebook consolidation: unknown tool', { tool: call.name }); continue }
        context.pipeToSelf(
          ask<ToolInvokeMsg, ToolReply>(entry.ref, (replyTo) => ({ type: 'invoke', toolName: call.name, arguments: call.arguments, replyTo })),
          (reply): NotebookConsolidationMsg => ({ type: '_toolResult', toolName: call.name, toolCallId: call.id, reply }),
          (error): NotebookConsolidationMsg => ({ type: '_toolResult', toolName: call.name, toolCallId: call.id, reply: { type: 'toolError', error: String(error) } }),
        )
      }

      return {
        state: { ...state, requestId: null, pendingBatch: batch },
        become: toolLoopHandler,
      }
    },

    llmDone: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }
      context.log.info('notebook consolidation complete')

      const usageEvents = (msg.usage && state.modelInfo)
        ? [emit(WsBroadcastTopic, { text: JSON.stringify({
            type:          'usage',
            role:          'notebook',
            model,
            inputTokens:   msg.usage.promptTokens,
            outputTokens:  msg.usage.completionTokens,
            contextWindow: state.modelInfo.contextWindow,
            cost: (msg.usage.promptTokens     / 1_000_000 * state.modelInfo.promptPer1M)
                + (msg.usage.completionTokens / 1_000_000 * state.modelInfo.completionPer1M),
          }) })]
        : []

      return {
        state: { ...state, requestId: null, turnMessages: null, accumulated: '', pendingBatch: null, toolLoopCount: 0 },
        events: usageEvents,
        become: idleHandler,
      }
    },

    llmError: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }
      context.log.error('notebook consolidation LLM error', { error: String(msg.error) })
      return {
        state: { ...state, requestId: null, turnMessages: null, accumulated: '', pendingBatch: null, toolLoopCount: 0 },
        become: idleHandler,
      }
    },

    _llmProvider:      llmProviderChanged,
    _modelInfo:        (state, msg) => ({ state: { ...state, modelInfo: msg.info } }),
    _toolRegistered:   toolRegistered,
    _toolUnregistered: toolUnregistered,
  })

  // ─── Handler: toolLoop ───

  toolLoopHandler = onMessage<NotebookConsolidationMsg, NotebookConsolidationState>({
    _consolidate: (state) => ({ state }),

    _toolResult: (state, msg, context) => {
      const batch   = state.pendingBatch!
      const content = msg.reply.type === 'toolResult' ? msg.reply.result : `Tool error: ${msg.reply.error}`
      const updated = [...batch.results, { toolCallId: msg.toolCallId, toolName: msg.toolName, content }]
      const remaining = batch.remaining - 1

      if (remaining > 0) {
        return { state: { ...state, pendingBatch: { ...batch, remaining, results: updated } } }
      }

      const nextLoopCount = state.toolLoopCount + 1
      if (nextLoopCount >= maxToolLoops) {
        context.log.warn('notebook consolidation tool loop limit', { limit: maxToolLoops })
        return {
          state: { ...state, requestId: null, turnMessages: null, accumulated: '', pendingBatch: null, toolLoopCount: 0 },
          become: idleHandler,
        }
      }

      const toolResultMsgs: ApiMessage[] = updated.map(r => ({
        role: 'tool', content: r.content, tool_call_id: r.toolCallId,
      }))
      const nextMessages: ApiMessage[] = [
        ...batch.messagesAtCall,
        { role: 'assistant', content: null, tool_calls: batch.assistantToolCalls },
        ...toolResultMsgs,
      ]

      const requestId   = crypto.randomUUID()
      const toolSchemas = Object.values(state.tools).map((e: ToolEntry) => e.schema as Tool)

      state.llmRef!.send({
        type: 'stream',
        requestId,
        model,
        messages: nextMessages,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state: { ...state, requestId, turnMessages: nextMessages, pendingBatch: null, toolLoopCount: nextLoopCount },
        become: awaitingLlmHandler,
      }
    },

    _llmProvider:      llmProviderChanged,
    _modelInfo:        (state, msg) => ({ state: { ...state, modelInfo: msg.info } }),
    _toolRegistered:   toolRegistered,
    _toolUnregistered: toolUnregistered,
  })

  return {
    lifecycle: onLifecycle({
      start: (_state, context) => {
        context.subscribe(LlmProviderTopic, (e) => ({ type: '_llmProvider' as const, ref: e.ref }))
        context.subscribe(ToolRegistrationTopic, (e) => {
          if (!applyToolFilter(e.name, CONSOLIDATION_TOOL_FILTER)) return null
          return e.ref === null
            ? { type: '_toolUnregistered' as const, name: e.name }
            : { type: '_toolRegistered' as const, name: e.name, schema: e.schema, ref: e.ref }
        })
        context.timers.startPeriodicTimer('consolidation', { type: '_consolidate' }, intervalMs)
        context.log.info('notebook consolidation started', { intervalMs, notebookDir })
        return { state: _state }
      },
    }),

    handler: idleHandler,
  }
}

export const INITIAL_CONSOLIDATION_STATE: NotebookConsolidationState = {
  llmRef:        null,
  modelInfo:     null,
  tools:         {},
  requestId:     null,
  turnMessages:  null,
  accumulated:   '',
  pendingBatch:  null,
  toolLoopCount: 0,
}
