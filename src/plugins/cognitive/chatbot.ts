import { emit } from '../../system/types.ts'
import type { ActorDef, ActorRef, ActorContext, ActorResult, PersistenceAdapter } from '../../system/types.ts'
import { onLifecycle } from '../../system/match.ts'
import {
  createReactLoop,
  initialReactLoopSlice,
  type ReactInvokeMsg,
  type ReactLoopSlice,
} from '../../system/react-loop.ts'
import { OutboundMessageTopic, UserStreamTopic } from '../../types/events.ts'
import type { ToolCollection, ToolFilter } from '../../types/tools.ts'
import { applyToolFilter, ToolRegistrationTopic } from '../../types/tools.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  TokenUsage,
  ToolCall,
} from '../../types/llm.ts'
import type { ChatbotMsg } from './types.ts'
import { UserContextTopic } from '../../types/memory.ts'

// ─── Conversation history ───

type ConversationMessage = {
  timestamp?: number
} & (
  | { role: 'user';      content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool';      content: string; tool_call_id: string }
)

// ─── State ───

export type ChatbotState = {
  loop:           ReactLoopSlice
  history:        ConversationMessage[]
  tools:          ToolCollection
  sessionUsage:   TokenUsage
  userContext:    string | null
  activeClientId: string
  /** Set by the userMessage adapter for the duration of a turn; read in onComplete to forward to UserStreamTopic. */
  isInjected?:    boolean
}

// ─── History markers ───

const HISTORY_MARKERS_NOTE =
  'Messages prefixed with [Internal Instruction] in the conversation history are past internal ' +
  'instructions that you already carried out. Do not act on them again.\n' +
  'Messages prefixed with [Background tool result — ...] are deferred results from long-running ' +
  'tools whose work has now completed. Use them to inform your reply to the user — relay the ' +
  'result naturally rather than restating the bracketed prefix.'

// ─── Options ───

export type ChatbotActorOptions = {
  clientId:            string
  model:               string
  systemPrompt?:       string
  historyWindowHours?: number
  toolFilter?:         ToolFilter
  maxToolLoops?:       number
  userId:              string
  roles?:              string[]
  llmRef?:             ActorRef<LlmProviderMsg> | null
}

// ─── Helpers ───

const buildSystemPrompt = (basePrompt: string | undefined, userContext: string | null): string => {
  const todayDateNote = `Today's date is ${new Date().toDateString()}.`
  return [basePrompt, todayDateNote, userContext, HISTORY_MARKERS_NOTE].filter(Boolean).join('\n\n---\n\n')
}

const trimHistory = (history: ConversationMessage[], historyWindowHours: number): ConversationMessage[] => {
  const cutoffTime = Date.now() - historyWindowHours * 60 * 60 * 1000
  let earliestValidIndex = history.length

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!
    const msgTime = msg.timestamp ?? Date.now()
    if (msgTime < cutoffTime) break
    if (msg.role === 'user') earliestValidIndex = i
  }

  return history.slice(earliestValidIndex)
}

const assembleUserText = (
  text:    string,
  images?: string[],
  audio?:  string,
  pdfs?:   string[],
): string => {
  let out = text
  if (images && images.length > 0) {
    const note = images.length === 1
      ? `[Image attached: "${images[0]}"]`
      : `[Images attached: ${images.map(p => `"${p}"`).join(', ')}]`
    out = out ? `${out}\n\n${note}` : note
  }
  if (audio) {
    const note = `[Audio attached: "${audio}"]`
    out = out ? `${out}\n\n${note}` : note
  }
  if (pdfs && pdfs.length > 0) {
    const note = pdfs.length === 1
      ? `[PDF attached: "${pdfs[0]}"]`
      : `[PDFs attached: ${pdfs.map(p => `"${p}"`).join(', ')}]`
    out = out ? `${out}\n\n${note}` : note
  }
  return out
}

// ─── Persistence ───

type PersistedChatbotState = { userContext: string | null }

const createPersistence = (
  userId:   string,
  clientId: string,
  llmRef:   ActorRef<LlmProviderMsg> | null,
): PersistenceAdapter<ChatbotState> => {
  const path = `workspace/history/${userId}.json`
  return {
    load: async () => {
      const file = Bun.file(path)
      if (!await file.exists()) return undefined
      const saved = JSON.parse(await file.text()) as PersistedChatbotState
      return {
        loop:           { ...initialReactLoopSlice(), llmRef },
        history:        [],
        tools:          {},
        sessionUsage:   { promptTokens: 0, completionTokens: 0 },
        userContext:    saved.userContext ?? null,
        activeClientId: clientId,
      }
    },
    save: async (state) => {
      const data: PersistedChatbotState = { userContext: state.userContext }
      await Bun.write(path, JSON.stringify(data, null, 2))
    },
  }
}

// ─── Invoke argument shape ───
//
// The userMessage adapter passes a structured payload directly through
// invoke.arguments — the react-loop is parameterized with this type so
// buildTurn reads fields without JSON round-tripping.
type ChatbotInvokeArgs = {
  llmText:     string  // text the LLM should see for this turn (may differ from history-form for cron)
  isInjected?: boolean
}

// ─── Actor ───

export const createChatbotActor = (options: ChatbotActorOptions): ActorDef<ChatbotMsg, ChatbotState> => {
  const {
    clientId,
    model,
    systemPrompt,
    historyWindowHours,
    toolFilter,
    maxToolLoops = 25,
    userId,
    llmRef: initialLlmRef = null,
  } = options

  type M   = ChatbotMsg
  type S   = ChatbotState
  type Ctx = ActorContext<M>

  // The replyTo on synthesized invokes is unused (chatbot streams via OutboundMessageTopic).
  const noopReplyTo = {
    name: 'chatbot-noop-sink',
    send: () => {},
  } as unknown as ReactInvokeMsg['replyTo']

  const synthesizeInvoke = (
    text:         string,
    traceId:      string,
    parentSpanId: string,
    isInjected?:  boolean,
  ): ReactInvokeMsg<ChatbotInvokeArgs> => ({
    type:         'invoke',
    toolName:     'chatbot-turn',
    arguments:    { llmText: text, isInjected },
    clientId,
    userId,
    replyTo:      noopReplyTo,
    traceId,
    parentSpanId,
  })

  // ─── React-loop ─────────────────────────────────────────────────────────

  const handlers = createReactLoop<S, M, ChatbotInvokeArgs>({
    role:         'reasoning',
    spanName:     'chatbot',
    logPrefix:    'chatbot',
    model,
    maxToolLoops,
    tools:        (s) => s.tools,
    spans:        'fromMessage',

    slice:    (s) => s.loop,
    setSlice: (s, loop) => ({ ...s, loop }),

    buildTurn: (state, msg) => {
      // arguments is structured (ChatbotInvokeArgs) — synthesizeInvoke is the
      // only producer, so we narrow without a runtime check.
      const { llmText } = msg.arguments as ChatbotInvokeArgs

      const sysPrompt = buildSystemPrompt(systemPrompt, state.userContext)

      // history already contains the current user turn (appended by the shell).
      // For the LLM-form, replace the last entry's content with llmText
      // (handles cron variant: "[Internal Instruction — do not mention…]" vs
      // history-form "[Internal Instruction]").
      const apiMessages: ApiMessage[] = [
        ...(sysPrompt ? [{ role: 'system' as const, content: sysPrompt }] : []),
        ...state.history.slice(0, -1).map(toApiMessage),
        { role: 'user' as const, content: llmText },
      ]
      return { messages: apiMessages }
    },

    onChunk: (state, text) => ({
      state,
      events: [emit(OutboundMessageTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'chunk', text }) })],
    }),

    onReasoningChunk: (state, text) => ({
      state,
      events: [emit(OutboundMessageTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'reasoningChunk', text }) })],
    }),

    interceptToolCalls: (state, calls) => ({
      handled: false,
      events:  [emit(OutboundMessageTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'searching', tools: calls.map(c => c.name) }) })],
    }),

    onToolResult: (state, result) => {
      // Append assistant-tool-call shell on the first result of a batch (when
      // pendingBatch.results is still empty), then the tool-result entry.
      // Subsequent results in the same batch only append the tool-result.
      const batch         = state.loop.turn.pendingBatch!
      const isFirstResult = batch.results.length === 0
      const content       = result.reply.type === 'toolResult' ? result.reply.result.text : `Tool error: ${result.reply.error}`
      const toolEntry: ConversationMessage = {
        role: 'tool', content, tool_call_id: result.toolCallId, timestamp: Date.now(),
      }
      const newHistory: ConversationMessage[] = isFirstResult
        ? [...state.history, { role: 'assistant', content: null, tool_calls: batch.assistantToolCalls, timestamp: Date.now() }, toolEntry]
        : [...state.history, toolEntry]

      const payload     = result.reply.type === 'toolResult' ? result.reply.result : undefined
      const events: ReturnType<typeof emit>[] = []
      if (payload?.sources?.length) {
        events.push(emit(OutboundMessageTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'sources', sources: payload.sources }) }))
      }
      if (payload?.attachments?.length) {
        events.push(emit(OutboundMessageTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'attachments', attachments: payload.attachments }) }))
      }

      return { state: { ...state, history: newHistory }, events }
    },

    onComplete: (state, finalText, _ctx) => {
      const turn = state.loop.turn
      // Append assistant message to history (if any text), trim, fold usage into session.
      const rawHistory: ConversationMessage[] = finalText
        ? [...state.history, { role: 'assistant', content: finalText, timestamp: Date.now() }]
        : state.history
      const history = historyWindowHours ? trimHistory(rawHistory, historyWindowHours) : rawHistory

      const sessionUsage: TokenUsage = {
        promptTokens:     state.sessionUsage.promptTokens     + turn.pendingUsage.promptTokens,
        completionTokens: state.sessionUsage.completionTokens + turn.pendingUsage.completionTokens,
      }

      // Recover the original user prompt from turnMessages (last user role) for telemetry.
      const userMsg  = turn.turnMessages?.findLast(m => m.role === 'user')
      const userText = typeof userMsg?.content === 'string' ? userMsg.content : ''

      return {
        state: { ...state, history, sessionUsage, isInjected: undefined },
        events: [
          emit(UserStreamTopic, { userId, userText, assistantText: finalText, timestamp: Date.now(), injected: state.isInjected }),
          emit(OutboundMessageTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'done' }) }),
        ],
      }
    },

    onLlmError: (state) => ({
      state: { ...state, isInjected: undefined },
      events: [emit(OutboundMessageTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'error', text: 'Something went wrong. Please try again.' }) })],
    }),

    onLoopLimit: (state, _finalText, ctx) => {
      ctx.log.warn('chatbot: tool loop limit reached', { clientId: state.activeClientId })
      return {
        state:  { ...state, isInjected: undefined },
        events: [emit(OutboundMessageTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'error', text: 'Tool loop limit reached. Please try again.' }) })],
      }
    },

    extraCases: {
      idle: {
        userMessage: (state: S, msg: Extract<M, { type: 'userMessage' }>, ctx: Ctx): ActorResult<M, S> =>
          handleUserMessage(state, msg, ctx),
        _toolUpdate: (state: S, msg: Extract<M, { type: '_toolUpdate' }>, ctx: Ctx): ActorResult<M, S> =>
          handleToolUpdate(state, msg, ctx),
        _toolRegistered:   toolRegistered,
        _toolUnregistered: toolUnregistered,
        _userContext:      setUserContext,
      },
      awaitingLlm: {
        _toolUpdate:       (state: S): ActorResult<M, S> => ({ state, stash: true }),
        _toolRegistered:   toolRegistered,
        _toolUnregistered: toolUnregistered,
        _userContext:      setUserContext,
      },
      toolLoop: {
        _toolUpdate:       (state: S): ActorResult<M, S> => ({ state, stash: true }),
        _toolRegistered:   toolRegistered,
        _toolUnregistered: toolUnregistered,
        _userContext:      setUserContext,
      },
    },
  })

  // ─── Shared state-mutation handlers (used in all three states) ──────────

  function toolRegistered (state: S, msg: Extract<M, { type: '_toolRegistered' }>): ActorResult<M, S> {
    return { state: { ...state, tools: { ...state.tools, [msg.name]: { schema: msg.schema, ref: msg.ref, mayBeLongRunning: msg.mayBeLongRunning } } } }
  }
  function toolUnregistered (state: S, msg: Extract<M, { type: '_toolUnregistered' }>): ActorResult<M, S> {
    const { [msg.name]: _, ...rest } = state.tools
    return { state: { ...state, tools: rest } }
  }
  function setUserContext (state: S, msg: Extract<M, { type: '_userContext' }>): ActorResult<M, S> {
    return { state: { ...state, userContext: msg.summary } }
  }

  // ─── Adapter: userMessage → invoke ──────────────────────────────────────

  function handleUserMessage (state: S, msg: Extract<M, { type: 'userMessage' }>, ctx: Ctx): ActorResult<M, S> {
    const { clientId: msgClientId, text, images, audio, pdfs, traceId, parentSpanId, isCron, isInjected } = msg

    // Cron: history-form differs from LLM-form. Otherwise both are identical.
    const userText = isCron
      ? `[Internal Instruction] ${text}`
      : assembleUserText(text, images, audio, pdfs)
    const llmText  = isCron
      ? `[Internal Instruction — do not mention that this is scheduled] ${text}`
      : userText

    const stateNext: S = {
      ...state,
      activeClientId: msgClientId,
      history:        [...state.history, { role: 'user', content: userText, timestamp: Date.now() }],
      isInjected:     isInjected || isCron || false,
    }

    return handlers.idle(stateNext, synthesizeInvoke(llmText, traceId, parentSpanId, stateNext.isInjected) as unknown as M, ctx)
  }

  // ─── Adapter: _toolUpdate (idle) → invoke ───────────────────────────────

  function handleToolUpdate (state: S, msg: Extract<M, { type: '_toolUpdate' }>, ctx: Ctx): ActorResult<M, S> {
    if (!state.loop.llmRef) {
      ctx.log.warn('chatbot: dropping _toolUpdate, no LLM ref', { toolName: msg.toolName, toolCallId: msg.toolCallId })
      return { state }
    }
    const resultText = msg.reply.type === 'toolResult' ? msg.reply.result.text : `Tool error: ${msg.reply.error}`
    const injection  = `[Background tool result — ${msg.toolName} (toolCallId=${msg.toolCallId})]: ${resultText}`

    // No upstream traceId for background completions — synthesize a fresh one.
    const traceId      = crypto.randomUUID().replace(/-/g, '').slice(0, 32)
    const parentSpanId = '0000000000000000'

    const stateNext: S = {
      ...state,
      history:    [...state.history, { role: 'user', content: injection, timestamp: Date.now() }],
      isInjected: true,
    }

    return handlers.idle(stateNext, synthesizeInvoke(injection, traceId, parentSpanId, true) as unknown as M, ctx)
  }

  // ─── ApiMessage projection ──────────────────────────────────────────────

  function toApiMessage (m: ConversationMessage): ApiMessage {
    if (m.role === 'user')      return { role: 'user',      content: m.content }
    if (m.role === 'assistant') return m.tool_calls
      ? { role: 'assistant', content: m.content, tool_calls: m.tool_calls }
      : { role: 'assistant', content: m.content ?? '' }
    return { role: 'tool', content: m.content, tool_call_id: m.tool_call_id }
  }

  return {
    persistence: createPersistence(userId, clientId, initialLlmRef),

    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(ToolRegistrationTopic, (event) => {
          if (!applyToolFilter(event.name, toolFilter)) return null
          if ('schema' in event) {
            return {
              type: '_toolRegistered' as const,
              name: event.name,
              schema: event.schema,
              ref: event.ref,
              mayBeLongRunning: event.mayBeLongRunning,
            }
          }
          return { type: '_toolUnregistered' as const, name: event.name }
        })

        ctx.subscribe(LlmProviderTopic, (event) =>
          ({ type: '_llmProvider' as const, ref: event.ref }),
        )

        ctx.subscribe(UserContextTopic, (event) => {
          if (event.userId !== userId) return null
          return { type: '_userContext' as const, summary: event.summary }
        })

        return { state }
      },
    }),

    handler: handlers.idle,

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
