import { emit } from '../../system/types.ts'
import type { ActorDef, ActorRef, ActorContext, ActorResult } from '../../system/types.ts'
import { onLifecycle } from '../../system/match.ts'
import { createReactLoop, initialReactLoopSlice, type ReactLoopSlice } from '../../system/react-loop.ts'
import { OutboundMessageTopic } from '../../types/events.ts'
import { UserStreamTopic } from '../../types/events.ts'
import type { ToolCollection, ToolFilter } from '../../types/tools.ts'
import { applyToolFilter, ToolRegistrationTopic } from '../../types/tools.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { ApiMessage, LlmProviderMsg, TokenUsage } from '../../types/llm.ts'
import type { ChatbotMsg } from './types.ts'
import { HistorySnapshotTopic } from './types.ts'
import type { HistoryStoreMsg } from './history-store.ts'

// ─── State ───
//
// `historyMirror` is a local cache of HistorySnapshotTopic (retained, keyed by
// userId). The chatbot reads from it when building turn payloads but never
// mutates it directly — appends go to the HistoryStore which republishes the
// snapshot, and the mirror updates via the subscription.

export type ChatbotState = {
  loop:           ReactLoopSlice
  historyMirror:  ApiMessage[]
  historyVersion: number
  tools:          ToolCollection
  sessionUsage:   TokenUsage
  userContext:    string | null
  activeClientId: string
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
  clientId:        string
  model:           string
  systemPrompt?:   string
  toolFilter?:     ToolFilter
  maxToolLoops?:   number
  userId:          string
  roles?:          string[]
  llmRef?:         ActorRef<LlmProviderMsg> | null
  historyStoreRef: ActorRef<HistoryStoreMsg>
}

// ─── Helpers ───

const buildSystemPrompt = (basePrompt: string | undefined, userContext: string | null): string => {
  const todayDateNote = `Today's date is ${new Date().toDateString()}.`
  return [basePrompt, todayDateNote, userContext, HISTORY_MARKERS_NOTE].filter(Boolean).join('\n\n---\n\n')
}

// User file attachments are encoded as text tokens in the user message content.
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

// ─── Initial state ───

const initialChatbotState = (): ChatbotState => ({
  loop:           initialReactLoopSlice(),
  historyMirror:  [],
  historyVersion: 0,
  tools:          {},
  sessionUsage:   { promptTokens: 0, completionTokens: 0 },
  userContext:    null,
  activeClientId: '',
})

// ─── Actor ───

export const createChatbotActor = (options: ChatbotActorOptions): ActorDef<ChatbotMsg, ChatbotState> => {
  const {
    clientId,
    model,
    systemPrompt,
    toolFilter,
    maxToolLoops = 25,
    userId,
    historyStoreRef,
  } = options

  type M   = ChatbotMsg
  type S   = ChatbotState
  type Ctx = ActorContext<M>

  // ─── Shared state-mutation handlers ─────────────────────────────────────

  const toolRegistered = (state: S, msg: Extract<M, { type: '_toolRegistered' }>): ActorResult<M, S> => {
    return { state: { ...state, tools: { ...state.tools, [msg.name]: { schema: msg.schema, ref: msg.ref, mayBeLongRunning: msg.mayBeLongRunning } } } }
  }
  const toolUnregistered = (state: S, msg: Extract<M, { type: '_toolUnregistered' }>): ActorResult<M, S> => {
    const { [msg.name]: _, ...rest } = state.tools
    return { state: { ...state, tools: rest } }
  }
  const historySnapshot = (state: S, msg: Extract<M, { type: '_historySnapshot' }>): ActorResult<M, S> => {
    if (msg.version <= state.historyVersion && state.historyVersion > 0) return { state }
    return {
      state: {
        ...state,
        historyMirror:  msg.messages,
        userContext:    msg.userContext,
        historyVersion: msg.version,
      },
    }
  }

  // ─── Build LLM payload ─────────────────────────────────────────────────
  //
  // `history` already includes the current user turn (appended optimistically
  // by the caller), so we replace its last entry's content with `llmText` to
  // accommodate cron-vs-history phrasing variants.
  const buildTurnMessages = (history: ApiMessage[], userContext: string | null, llmText: string): ApiMessage[] => {
    const sysPrompt = buildSystemPrompt(systemPrompt, userContext)
    return [
      ...(sysPrompt ? [{ role: 'system' as const, content: sysPrompt }] : []),
      ...history.slice(0, -1),
      { role: 'user' as const, content: llmText },
    ]
  }

  // ─── React-loop ────────────────────────────────────────────────────────

  const handlers = createReactLoop<S, M>({
    role:         'reasoning',
    spanName:     'chatbot',
    logPrefix:    'chatbot',
    model,
    maxToolLoops,
    tools:        (s) => s.tools,
    spans:        'fromMessage',

    slice:    (s) => s.loop,
    setSlice: (s, loop) => ({ ...s, loop }),

    onChunk: (state, text) => ({
      state,
      events: [emit(OutboundMessageTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'chunk', text }) })],
    }),

    onReasoningChunk: (state, text) => ({
      state,
      events: [emit(OutboundMessageTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'reasoningChunk', text }) })],
    }),

    onToolPending: ({ toolName, toolCallId }, reply) =>
      ({ type: '_toolUpdate', toolName, toolCallId, reply } as unknown as M),

    onToolCalls: (state, calls) => ({
      events: [emit(OutboundMessageTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'tooling', tools: calls.map(c => c.name) }) })],
    }),

    // Streaming UI events only. History bookkeeping moved to onBatchHistoryReady.
    onToolResult: (state, result) => {
      const payload = result.reply.type === 'toolResult' ? result.reply.result : undefined
      const events: ReturnType<typeof emit>[] = []
      if (payload?.sources?.length) {
        events.push(emit(OutboundMessageTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'sources', sources: payload.sources }) }))
      }
      if (payload?.attachments?.length) {
        events.push(emit(OutboundMessageTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'attachments', attachments: payload.attachments }) }))
      }
      return events.length > 0 ? { state, events } : { state }
    },

    // Forward the canonical batch sequence to the HistoryStore.
    onBatchHistoryReady: (state, messages) => {
      historyStoreRef.send({ type: 'append', messages })
      return { state }
    },

    onComplete: (state, finalText, _ctx) => {
      const turn = state.loop.turn
      if (finalText) {
        historyStoreRef.send({ type: 'append', messages: [{ role: 'assistant', content: finalText }] })
      }

      const sessionUsage: TokenUsage = {
        promptTokens:     state.sessionUsage.promptTokens     + turn.pendingUsage.promptTokens,
        completionTokens: state.sessionUsage.completionTokens + turn.pendingUsage.completionTokens,
      }

      const userMsg  = turn.turnMessages?.findLast(m => m.role === 'user')
      const userText = typeof userMsg?.content === 'string' ? userMsg.content : ''

      return {
        state: { ...state, sessionUsage, isInjected: undefined },
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
        userMessage:       (state: S, msg: Extract<M, { type: 'userMessage' }>, ctx: Ctx): ActorResult<M, S> => handleUserMessage(state, msg, ctx),
        _toolUpdate:       (state: S, msg: Extract<M, { type: '_toolUpdate' }>, ctx: Ctx): ActorResult<M, S> => handleToolUpdate(state, msg, ctx),
        _toolRegistered:   toolRegistered,
        _toolUnregistered: toolUnregistered,
        _historySnapshot:  historySnapshot,
      },
      awaitingLlm: {
        _toolUpdate:       (state: S): ActorResult<M, S> => ({ state, stash: true }),
        _toolRegistered:   toolRegistered,
        _toolUnregistered: toolUnregistered,
        _historySnapshot:  historySnapshot,
      },
      toolLoop: {
        _toolUpdate:       (state: S): ActorResult<M, S> => ({ state, stash: true }),
        _toolRegistered:   toolRegistered,
        _toolUnregistered: toolUnregistered,
        _historySnapshot:  historySnapshot,
      },
    },
  })

  // ─── Adapter: userMessage → startTurn ───────────────────────────────────

  const handleUserMessage = (state: S, msg: Extract<M, { type: 'userMessage' }>, ctx: Ctx): ActorResult<M, S> => {
    const { clientId: msgClientId, text, images, audio, pdfs, traceId, parentSpanId, isCron, isInjected } = msg

    const userText = isCron
      ? `[Internal Instruction] ${text}`
      : assembleUserText(text, images, audio, pdfs)

    const userMessage: ApiMessage = { role: 'user', content: userText }

    // Optimistically include the user turn in this turn's payload — the
    // snapshot republish from the HistoryStore will arrive shortly and make
    // the local mirror consistent.
    const optimisticHistory: ApiMessage[] = [...state.historyMirror, userMessage]

    const stateNext: S = {
      ...state,
      activeClientId: msgClientId,
      historyMirror:  optimisticHistory,
      isInjected:     isInjected || isCron || false,
    }

    historyStoreRef.send({ type: 'append', messages: [userMessage] })

    if (!stateNext.loop.llmRef) {
      ctx.log.warn('chatbot: dropping userMessage, no LLM ref', { clientId: msgClientId })
      return { state: stateNext }
    }

    return handlers.startTurn(stateNext, {
      messages: buildTurnMessages(optimisticHistory, stateNext.userContext, userText),
      userId,
      clientId,
      traceId,
      parentSpanId,
    }, ctx)
  }

  // ─── Adapter: _toolUpdate (idle) → startTurn ────────────────────────────

  const handleToolUpdate = (state: S, msg: Extract<M, { type: '_toolUpdate' }>, ctx: Ctx): ActorResult<M, S> => {
    if (!state.loop.llmRef) {
      ctx.log.warn('chatbot: dropping _toolUpdate, no LLM ref', { toolName: msg.toolName, toolCallId: msg.toolCallId })
      return { state }
    }
    const resultText = msg.reply.type === 'toolResult' ? msg.reply.result.text : `Tool error: ${msg.reply.error}`
    const injection  = `[Background tool result — ${msg.toolName} (toolCallId=${msg.toolCallId})]: ${resultText}`

    const traceId      = crypto.randomUUID().replace(/-/g, '').slice(0, 32)
    const parentSpanId = '0000000000000000'

    const userMessage: ApiMessage = { role: 'user', content: injection }
    const optimisticHistory: ApiMessage[] = [...state.historyMirror, userMessage]

    const stateNext: S = {
      ...state,
      historyMirror: optimisticHistory,
      isInjected:    true,
    }

    historyStoreRef.send({ type: 'append', messages: [userMessage] })

    const payload = msg.reply.type === 'toolResult' ? msg.reply.result : undefined
    if (payload?.sources?.length) {
      ctx.publish(OutboundMessageTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'sources', sources: payload.sources }) })
    }
    if (payload?.attachments?.length) {
      ctx.publish(OutboundMessageTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'attachments', attachments: payload.attachments }) })
    }

    return handlers.startTurn(stateNext, {
      messages: buildTurnMessages(optimisticHistory, stateNext.userContext, injection),
      userId,
      clientId,
      traceId,
      parentSpanId,
    }, ctx)
  }

  return {
    initialState: initialChatbotState,
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

        ctx.subscribe(HistorySnapshotTopic, (event) => {
          if (event.userId !== userId) return null
          return {
            type: '_historySnapshot' as const,
            messages:    event.messages,
            userContext: event.userContext,
            version:     event.version,
          }
        })

        return { state }
      },
    }),

    handler: handlers.idle,

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
