import { emit } from '../../system/types.ts'
import type { ActorDef, ActorRef, ActorContext, ActorResult, Interceptor } from '../../system/types.ts'
import { onLifecycle } from '../../system/match.ts'
import { AgentLoop, type AgentLoopHandle, type LoopTurn } from '../../system/agent-loop.ts'
import { OutboundMessageTopic } from '../../types/events.ts'
import { UserStreamTopic } from '../../types/events.ts'
import type { ToolCollection, ToolFilter } from '../../types/tools.ts'
import { applyToolFilter, ToolRegistrationTopic } from '../../types/tools.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { ApiMessage, LlmProviderMsg, TokenUsage } from '../../types/llm.ts'
import type { ChatbotMsg } from './types.ts'
import { HistorySnapshotTopic } from './types.ts'
import type { AgentFactoryOpts } from './types.ts'
import type { HistoryStoreMsg } from './history-store.ts'

// ─── State ───

export type ChatbotState = {
  historyMirror:  ApiMessage[]
  historyVersion: number
  tools:          ToolCollection
  llmRef:         ActorRef<LlmProviderMsg> | null
  sessionUsage:   TokenUsage
  userContext:    string | null
  activeClientId: string
  isInjected?:    boolean
}

const HISTORY_MARKERS_NOTE =
  'Messages prefixed with [Internal Instruction] in the conversation history are past internal ' +
  'instructions that you already carried out. Do not act on them again.\n' +
  'Messages prefixed with [Background tool result — ...] are deferred results from long-running ' +
  'tools whose work has now completed. Use them to inform your reply to the user — relay the ' +
  'result naturally rather than restating the bracketed prefix.'

export type ChatbotAgentConfig = {
  model:         string
  systemPrompt?: string
  toolFilter?:   ToolFilter
  maxToolLoops?: number
}

const buildSystemPrompt = (basePrompt: string | undefined, userContext: string | null): string => {
  const todayDateNote = `Today's date is ${new Date().toDateString()}.`
  return [basePrompt, todayDateNote, userContext, HISTORY_MARKERS_NOTE].filter(Boolean).join('\n\n---\n\n')
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
      ? `[Image attached: "${images[0]}"] `
      : `[Images attached: ${images.map(p => `"${p}"`).join(', ')}]`
    out = out ? `${out}\n\n${note}` : note
  }
  if (audio) {
    const note = `[Audio attached: "${audio}"]`
    out = out ? `${out}\n\n${note}` : note
  }
  if (pdfs && pdfs.length > 0) {
    const note = pdfs.length === 1
      ? `[PDF attached: "${pdfs[0]}"] `
      : `[PDFs attached: ${pdfs.map(p => `"${p}"`).join(', ')}]`
    out = out ? `${out}\n\n${note}` : note
  }
  return out
}

const initialChatbotState = (): ChatbotState => ({
  historyMirror:  [],
  historyVersion: 0,
  tools:          {},
  llmRef:         null,
  sessionUsage:   { promptTokens: 0, completionTokens: 0 },
  userContext:    null,
  activeClientId: '',
})

export const ChatbotAgentFactory = (config: ChatbotAgentConfig) =>
  (opts: AgentFactoryOpts): ActorDef<ChatbotMsg, ChatbotState> =>
    Chatbot(config, opts)

export const Chatbot = (
  config: ChatbotAgentConfig,
  opts:   AgentFactoryOpts,
): ActorDef<ChatbotMsg, ChatbotState> => {
  const { model, systemPrompt, toolFilter, maxToolLoops = 25 } = config
  const { userId, historyStoreRef } = opts

  type M   = ChatbotMsg
  type S   = ChatbotState
  type Ctx = ActorContext<M>

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

  const buildTurnMessages = (history: ApiMessage[], userContext: string | null, llmText: string): ApiMessage[] => {
    const sysPrompt = buildSystemPrompt(systemPrompt, userContext)
    return [
      ...(sysPrompt ? [{ role: 'system' as const, content: sysPrompt }] : []),
      ...history.slice(0, -1),
      { role: 'user' as const, content: llmText },
    ]
  }

  let loop: AgentLoopHandle<M, S>

  loop = AgentLoop<S, M>({
    role:          'reasoning',
    spanName:      'chatbot',
    logPrefix:     'chatbot',
    model,
    maxToolLoops,
    llmRef:        (s) => s.llmRef,
    tools:         (s) => s.tools,

    backgroundCompletionMessage: (toolName, toolCallId, reply) => ({
      type: '_bgToolDone',
      toolName,
      toolCallId,
      reply,
    } as M),

    onStream: (state, { kind, text }) => ({
      state,
      events: [emit(OutboundMessageTopic, {
        clientId: state.activeClientId,
        text: JSON.stringify({ type: kind === 'reasoning' ? 'reasoningChunk' : 'chunk', text }),
      })],
    }),

    onToolCalls: (state, calls) => ({
      events: [emit(OutboundMessageTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'tooling', tools: calls.map(c => c.name) }) })],
    }),

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

    onBatchHistoryReady: (state, messages) => {
      historyStoreRef.send({ type: 'append', messages })
      return { state }
    },

    onComplete: (state, finalText, turn, _ctx) => {
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
  })

  const handleUserMessage = (state: S, msg: Extract<M, { type: 'userMessage' }>, ctx: Ctx): ActorResult<M, S> => {
    const { clientId: msgClientId, text, images, audio, pdfs, isCron, isInjected } = msg

    const userText = isCron ? `[Internal Instruction] ${text}` : assembleUserText(text, images, audio, pdfs)

    const userMessage: ApiMessage = { role: 'user', content: userText }

    const optimisticHistory: ApiMessage[] = [...state.historyMirror, userMessage]

    const stateNext: S = {
      ...state,
      activeClientId: msgClientId,
      historyMirror:  optimisticHistory,
      isInjected:     isInjected || isCron || false,
    }

    historyStoreRef.send({ type: 'append', messages: [userMessage] })

    return loop.startTurn(stateNext, {
      messages: buildTurnMessages(optimisticHistory, stateNext.userContext, userText),
      userId,
      clientId: msgClientId,
    }, ctx)
  }

  const handleBackgroundResult = (state: S, msg: Extract<M, { type: '_bgToolDone' }>, ctx: Ctx): ActorResult<M, S> => {
    const resultText = msg.reply.type === 'toolResult' ? msg.reply.result.text : `Tool error: ${msg.reply.error}`
    const injection = `[Background tool result — ${msg.toolName} (toolCallId=${msg.toolCallId})]: ${resultText}`
    const userMessage: ApiMessage = { role: 'user', content: injection }

    historyStoreRef.send({ type: 'append', messages: [userMessage] })

    const payload = msg.reply.type === 'toolResult' ? msg.reply.result : undefined
    if (payload?.sources?.length) {
      ctx.publish(OutboundMessageTopic, {
        clientId: state.activeClientId,
        text: JSON.stringify({ type: 'sources', sources: payload.sources }),
      })
    }
    if (payload?.attachments?.length) {
      ctx.publish(OutboundMessageTopic, {
        clientId: state.activeClientId,
        text: JSON.stringify({ type: 'attachments', attachments: payload.attachments }),
      })
    }
    const optimisticHistory = [...state.historyMirror, userMessage]
    const stateNext = { ...state, historyMirror: optimisticHistory, isInjected: true }
    return loop.startTurn(stateNext, {
      messages: buildTurnMessages(optimisticHistory, stateNext.userContext, injection),
      userId,
      clientId: state.activeClientId,
    }, ctx)
  }

  const hostInterceptor: Interceptor<M, S> = (state, msg, ctx, next) => {
    const m = msg as M

    if (m.type === '_historySnapshot') {
      return historySnapshot(state, m as Extract<M, { type: '_historySnapshot' }>)
    }

    if (m.type === 'userMessage') {
      if (loop.phase !== 'idle') return { state, stash: true }
      return handleUserMessage(state, m as Extract<M, { type: 'userMessage' }>, ctx)
    }

    if (m.type === '_bgToolDone') {
      return handleBackgroundResult(state, m as Extract<M, { type: '_bgToolDone' }>, ctx)
    }

    if (m.type === '_llmProvider') {
      return { state: { ...state, llmRef: m.ref } }
    }

    if (m.type === '_toolRegistered') {
      return {
        state: {
          ...state,
          tools: {
            ...state.tools,
            [m.name]: { schema: m.schema, ref: m.ref, mayBeLongRunning: m.mayBeLongRunning },
          },
        },
      }
    }

    if (m.type === '_toolUnregistered') {
      const { [m.name]: _, ...rest } = state.tools
      return { state: { ...state, tools: rest } }
    }

    return next(state, msg)
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

        ctx.subscribe(HistorySnapshotTopic, (event) => {
          if (event.userId !== userId) return null
          return {
            type: '_historySnapshot' as const,
            messages:    event.messages,
            userContext: event.userContext,
            version:     event.version,
          }
        })

        ctx.subscribe(LlmProviderTopic, (e) => ({
          type: '_llmProvider' as const,
          ref: e.ref,
        }))

        return { state }
      },
    }),

    handler:      loop.idle,
    interceptors: [hostInterceptor],

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
