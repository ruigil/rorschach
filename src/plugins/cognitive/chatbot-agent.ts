import type { ActorDef, ActorRef, ActorContext, ActorResult, Interceptor } from '../../system/types.ts'
import { onLifecycle } from '../../system/match.ts'
import { agentLoop, idleLoopState, type LoopMsg, type LoopState } from '../../system/agent-loop.ts'
import { OutboundMessageTopic } from '../../types/events.ts'
import { UserStreamTopic } from '../../types/events.ts'
import type { ToolCollection, ToolFilter, ToolFinalReply, ToolMsg, ToolSchema } from '../../types/tools.ts'
import { applyToolFilter, ToolRegistrationTopic } from '../../types/tools.ts'
import type { ApiMessage, TokenUsage } from '../../types/llm.ts'
import { HistorySnapshotTopic, type AgentFactoryOpts } from '../../types/agents.ts'

// ─── State ───

export type ChatbotState = {
  loop:           LoopState
  historyMirror:  ApiMessage[]
  historyVersion: number
  tools:          ToolCollection
  sessionUsage:   TokenUsage
  userContext:    string | null
  activeClientId: string
  isInjected?:    boolean
}
// ─── Chatbot actor message protocol ───

type ChatbotExtra =
  | { type: 'userMessage';      clientId: string; text: string; images?: string[]; audio?: string; pdfs?: string[]; isCron?: boolean; isInjected?: boolean }
  | { type: '_historySnapshot'; messages: ApiMessage[]; userContext: string | null; version: number }
  | { type: '_toolRegistered';  name: string; schema: ToolSchema; ref: ActorRef<ToolMsg>; mayBeLongRunning?: boolean }
  | { type: '_toolUnregistered'; name: string }
  | { type: '_bgToolDone';      toolName: string; toolCallId: string; reply: ToolFinalReply }

export type ChatbotMsg = LoopMsg<ChatbotExtra>

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
  loop:           idleLoopState(),
  historyMirror:  [],
  historyVersion: 0,
  tools:          {},
  sessionUsage:   { promptTokens: 0, completionTokens: 0 },
  userContext:    null,
  activeClientId: '',
})

export const ChatbotAgentFactory = (config: ChatbotAgentConfig) =>
  (opts: AgentFactoryOpts): ActorDef<ChatbotMsg, ChatbotState> => Chatbot(config, opts)

export const Chatbot = (
  config: ChatbotAgentConfig,
  opts:   AgentFactoryOpts,
): ActorDef<ChatbotMsg, ChatbotState> => {
  const { model, systemPrompt, toolFilter, maxToolLoops = 25 } = config
  const { userId, historyStoreRef, llmRef } = opts

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


  const loop = agentLoop<S, M>({
    role:          'reasoning',
    spanName:      'chatbot',
    logPrefix:     'chatbot',
    model,
    maxToolLoops,
    llmRef:        () => llmRef,
    tools:         (s) => s.tools,

    uiEvents:      OutboundMessageTopic,
    errorMessages: {
      llm:      'Something went wrong. Please try again.',
      loopLimit: 'Tool loop limit reached. Please try again.',
    },

    backgroundCompletionMessage: (toolName, toolCallId, reply) => ({
      type: '_bgToolDone',
      toolName,
      toolCallId,
      reply,
    } as M),

    onBatchHistoryReady: (state, messages) => {
      historyStoreRef.send({ type: 'append', messages })
      return { state }
    },

    onComplete: (state, finalText, usage, ctx) => {
      if (finalText) {
        historyStoreRef.send({ type: 'append', messages: [{ role: 'assistant', content: finalText }] })
      }

      const sessionUsage: TokenUsage = {
        promptTokens:     state.sessionUsage.promptTokens     + usage.promptTokens,
        completionTokens: state.sessionUsage.completionTokens + usage.completionTokens,
      }

      const userMsg  = [...state.historyMirror].reverse().find(m => m.role === 'user')
      const userText = typeof userMsg?.content === 'string' ? userMsg.content : ''

      ctx.publish(UserStreamTopic, { userId, userText, assistantText: finalText, timestamp: Date.now(), injected: state.isInjected })

      return {
        state: { ...state, sessionUsage, isInjected: undefined },
      }
    },

    onError: (state, err, ctx) => {
      if (err.kind === 'loopLimit') {
        ctx.log.warn('chatbot: tool loop limit reached', { clientId: state.activeClientId })
      }
      return { state: { ...state, isInjected: undefined } }
    },
  })

  const doStartTurn = (
    state: S,
    userText: string,
    clientId: string,
    isInjected: boolean,
    ctx: Ctx,
  ): ActorResult<M, S> => {
    const userMessage: ApiMessage = { role: 'user', content: userText }
    const optimisticHistory: ApiMessage[] = [...state.historyMirror, userMessage]

    const stateNext: S = {
      ...state,
      activeClientId: clientId,
      historyMirror:  optimisticHistory,
      isInjected,
    }

    historyStoreRef.send({ type: 'append', messages: [userMessage] })

    return loop.startTurn(stateNext, {
      messages: buildTurnMessages(optimisticHistory, stateNext.userContext, userText),
      userId,
      clientId,
    }, ctx)
  }

  const handleUserMessage = (state: S, msg: Extract<M, { type: 'userMessage' }>, ctx: Ctx): ActorResult<M, S> => {
    const { clientId: msgClientId, text, images, audio, pdfs, isCron, isInjected } = msg
    const userText = isCron ? `[Internal Instruction] ${text}` : assembleUserText(text, images, audio, pdfs)
    return doStartTurn(state, userText, msgClientId, isInjected || isCron || false, ctx)
  }

  const handleBackgroundResult = (state: S, msg: Extract<M, { type: '_bgToolDone' }>, ctx: Ctx): ActorResult<M, S> => {
    const resultText = msg.reply.type === 'toolResult' ? msg.reply.result.text : `Tool error: ${msg.reply.error}`
    const userText = `[Background tool result — ${msg.toolName} (toolCallId=${msg.toolCallId})]: ${resultText}`

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

    return doStartTurn(state, userText, state.activeClientId, true, ctx)
  }

  const hostInterceptor: Interceptor<M, S> = (state, msg, ctx, next) => {
    const m = msg as M

    if (m.type === '_historySnapshot') {
      return historySnapshot(state, m as Extract<M, { type: '_historySnapshot' }>)
    }

    if (m.type === 'userMessage') {
      if (state.loop.phase !== 'idle') return { state, stash: true }
      return handleUserMessage(state, m as Extract<M, { type: 'userMessage' }>, ctx)
    }

    if (m.type === '_bgToolDone') {
      return handleBackgroundResult(state, m as Extract<M, { type: '_bgToolDone' }>, ctx)
    }

    if (m.type === '_toolRegistered') {
      return {
        state: {
          ...state,
          tools: {
            ...state.tools,
            [m.name]: { name: m.name, schema: m.schema, ref: m.ref, mayBeLongRunning: m.mayBeLongRunning },
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

        return { state }
      },
    }),

    handler:      loop.idle,
    interceptors: [hostInterceptor],

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
