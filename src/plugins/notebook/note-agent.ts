import type { ActorDef, ActorRef, MessageHandler } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { ask } from '../../system/ask.ts'
import type { ToolCollection, ToolEntry, ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import type { ToolSchema } from '../../types/tools.ts'
import { ToolRegistrationTopic } from '../../types/tools.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  LlmProviderReply,
  Tool,
  ToolCall,
} from '../../types/llm.ts'
import type { NoteAgentMsg, PendingBatch } from './types.ts'

// ─── Options ───

export type NoteAgentOptions = {
  model:        string
  notebookDir:  string
  maxToolLoops: number
  tools:        ToolCollection
}

// ─── State ───

export type NoteAgentState = {
  llmRef:        ActorRef<LlmProviderMsg> | null
  model:         string
  notebookDir:   string
  maxToolLoops:  number
  tools:         ToolCollection   // fixed at spawn; never from ToolRegistrationTopic

  // Per-invocation (cleared when idle)
  requestId:     string | null
  replyTo:       ActorRef<ToolReply> | null
  clientId:      string | undefined
  turnMessages:  ApiMessage[] | null
  pending:       string
  pendingBatch:  PendingBatch | null
  toolLoopCount: number
}

// ─── Helpers ───

const todayISO = (): string => new Date().toISOString().slice(0, 10)

const buildSystemPrompt = (notebookDir: string): string =>
  `You are a notebook agent. Today is ${todayISO()}.\n` +
  `You manage a personal notebook stored at "${notebookDir}".\n\n` +
  `Available areas:\n` +
  `- Journal: daily markdown entries (journal_write, journal_read, journal_search)\n` +
  `- Notes: tagged notes with [[wiki-links]] (notes_create, notes_update, notes_read, notes_list, notes_search, notes_attach_image)\n` +
  `- Tracker: habit logging and statistics in CSV (tracker_log, tracker_stats, tracker_define_habit, tracker_list_habits)\n` +
  `- Todos: task list with due dates and recurrence (todos_create, todos_complete, todos_list, todos_delete, todos_update)\n` +
  `- Search: cross-content full-text search (notebook_search)\n\n` +
  `Use the appropriate tools to fulfill the user's request. Reply with a concise summary of what you did.`

const resetTurn = (state: NoteAgentState): NoteAgentState => ({
  ...state,
  requestId:     null,
  replyTo:       null,
  clientId:      undefined,
  turnMessages:  null,
  pending:       '',
  pendingBatch:  null,
  toolLoopCount: 0,
})

// ─── Actor ───

export const createNoteAgentActor = (options: NoteAgentOptions): ActorDef<NoteAgentMsg, NoteAgentState> => {
  const { model, notebookDir, maxToolLoops, tools } = options

  let awaitingLlmHandler: MessageHandler<NoteAgentMsg, NoteAgentState>
  let toolLoopHandler:    MessageHandler<NoteAgentMsg, NoteAgentState>

  // ─── Handler: idle ───

  const idleHandler: MessageHandler<NoteAgentMsg, NoteAgentState> = onMessage<NoteAgentMsg, NoteAgentState>({
    invoke: (state, msg, context) => {
      let request: string
      try {
        const args = JSON.parse(msg.arguments) as { request?: string }
        request = args.request ?? msg.arguments
      } catch {
        msg.replyTo.send({ type: 'toolError', error: 'Invalid arguments: expected { request: string }' })
        return { state }
      }

      if (!state.llmRef) {
        msg.replyTo.send({ type: 'toolError', error: 'Notebook agent not ready (no LLM provider).' })
        return { state }
      }

      const requestId   = crypto.randomUUID()
      const messages: ApiMessage[] = [
        { role: 'system', content: buildSystemPrompt(notebookDir) },
        { role: 'user',   content: request },
      ]
      const toolSchemas = Object.values(state.tools).map((e: ToolEntry) => e.schema as Tool)

      state.llmRef.send({
        type: 'stream',
        requestId,
        model: state.model,
        messages,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state: {
          ...state,
          requestId,
          replyTo:      msg.replyTo,
          clientId:     msg.clientId,
          turnMessages: messages,
          pending:      '',
          pendingBatch: null,
          toolLoopCount: 0,
        },
        become: awaitingLlmHandler,
      }
    },

    _llmProviderUpdated: (state, msg) => ({ state: { ...state, llmRef: msg.ref } }),
  })

  // ─── Handler: awaitingLlm ───

  awaitingLlmHandler = onMessage<NoteAgentMsg, NoteAgentState>({
    // Stash concurrent invocations — processed after this turn completes
    invoke: (state) => ({ state, stash: true }),

    llmChunk: (state, msg) => {
      if (msg.requestId !== state.requestId) return { state }
      return { state: { ...state, pending: state.pending + msg.text } }
    },

    llmReasoningChunk: (state) => ({ state }),

    llmToolCalls: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }

      const assistantToolCalls: ToolCall[] = msg.calls.map(c => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments },
      }))

      const unknownCall = msg.calls.find(c => !state.tools[c.name])
      if (unknownCall) {
        context.log.warn('note-agent: unknown tool', { tool: unknownCall.name })
        state.replyTo?.send({ type: 'toolError', error: `Tool not available: ${unknownCall.name}` })
        return { state: resetTurn(state), become: idleHandler, unstashAll: true }
      }

      const batch: PendingBatch = {
        remaining: msg.calls.length,
        results: [],
        messagesAtCall: state.turnMessages!,
        assistantToolCalls,
      }

      for (const call of msg.calls) {
        const entry = state.tools[call.name]!
        context.pipeToSelf(
          ask<ToolInvokeMsg, ToolReply>(
            entry.ref,
            (replyTo) => ({ type: 'invoke', toolName: call.name, arguments: call.arguments, replyTo, clientId: state.clientId }),
          ),
          (reply): NoteAgentMsg => ({ type: '_toolResult', toolName: call.name, toolCallId: call.id, reply }),
          (error): NoteAgentMsg => ({
            type: '_toolResult', toolName: call.name, toolCallId: call.id,
            reply: { type: 'toolError', error: String(error) },
          }),
        )
      }

      return {
        state: { ...state, requestId: null, pendingBatch: batch },
        become: toolLoopHandler,
      }
    },

    llmDone: (state, msg) => {
      if (msg.requestId !== state.requestId) return { state }
      state.replyTo?.send({ type: 'toolResult', result: state.pending || '(done)' })
      return { state: resetTurn(state), become: idleHandler, unstashAll: true }
    },

    llmError: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }
      context.log.error('note-agent LLM error', { error: String(msg.error) })
      state.replyTo?.send({ type: 'toolError', error: 'Notebook agent encountered an LLM error.' })
      return { state: resetTurn(state), become: idleHandler, unstashAll: true }
    },

    _llmProviderUpdated: (state, msg) => ({ state: { ...state, llmRef: msg.ref } }),
  })

  // ─── Handler: toolLoop ───

  toolLoopHandler = onMessage<NoteAgentMsg, NoteAgentState>({
    invoke: (state) => ({ state, stash: true }),

    _toolResult: (state, msg, context) => {
      const batch   = state.pendingBatch!
      const content = msg.reply.type === 'toolResult' ? msg.reply.result : `Tool error: ${msg.reply.error}`
      const updated = [...batch.results, { toolCallId: msg.toolCallId, toolName: msg.toolName, content }]
      const remaining = batch.remaining - 1

      if (remaining > 0) {
        return { state: { ...state, pendingBatch: { ...batch, remaining, results: updated } } }
      }

      // All tools done
      const nextLoopCount = state.toolLoopCount + 1

      if (nextLoopCount >= maxToolLoops) {
        context.log.warn('note-agent tool loop limit reached', { limit: maxToolLoops })
        state.replyTo?.send({ type: 'toolError', error: 'Tool loop limit reached.' })
        return { state: resetTurn(state), become: idleHandler, unstashAll: true }
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
        model: state.model,
        messages: nextMessages,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state: {
          ...state,
          requestId,
          turnMessages: nextMessages,
          pending:      '',
          pendingBatch: null,
          toolLoopCount: nextLoopCount,
        },
        become: awaitingLlmHandler,
      }
    },

    _llmProviderUpdated: (state, msg) => ({ state: { ...state, llmRef: msg.ref } }),
  })

  return {
    lifecycle: onLifecycle({
      start: (_state, context) => {
        context.subscribe(LlmProviderTopic, (e) => ({ type: '_llmProviderUpdated' as const, ref: e.ref }))
        // NOTE: deliberately NOT subscribing to ToolRegistrationTopic — tools are private
        return { state: _state }
      },
    }),

    handler: idleHandler,

    stashCapacity: 50,
    supervision:   { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}

export const createInitialNoteAgentState = (options: NoteAgentOptions): NoteAgentState => ({
  llmRef:        null,
  model:         options.model,
  notebookDir:   options.notebookDir,
  maxToolLoops:  options.maxToolLoops,
  tools:         options.tools,
  requestId:     null,
  replyTo:       null,
  clientId:      undefined,
  turnMessages:  null,
  pending:       '',
  pendingBatch:  null,
  toolLoopCount: 0,
})
