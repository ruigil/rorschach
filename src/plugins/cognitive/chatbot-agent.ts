import type { ActorDef, ActorRef, ActorContext, ActorResult, Interceptor } from '../../system/types.ts'
import { onLifecycle } from '../../system/match.ts'
import { agentLoop, idleLoopState, type LoopMsg, type LoopState } from '../../system/agent-loop.ts'
import { OutboundMessageTopic } from '../../types/events.ts'
import type { ToolCollection, ToolFilter, ToolFinalReply, ToolMsg, ToolSchema } from '../../types/tools.ts'
import { applyToolFilter } from '../../system/tool-utils.ts'
import { ToolRegistrationTopic } from '../../types/tools.ts'
import type { ApiMessage, TokenUsage } from '../../types/llm.ts'
import { ContextSnapshotTopic, type AgentFactoryOpts, type ContextSnapshotEvent } from '../../types/agents.ts'
import { assembleAgentMessages, type ContextView } from '../../system/context-assembly.ts'
import type { MessageAttachment } from '../../types/events.ts'

// ─── State ───

export type ChatbotState = {
  loop:           LoopState
  contextView:    ContextView
  tools:          ToolCollection
  sessionUsage:   TokenUsage
  activeClientId: string
}
// ─── Chatbot actor message protocol ───

type ChatbotExtra =
  | { type: 'userMessage';      clientId: string; text: string; attachments?: MessageAttachment[]; isCron?: boolean; isInjected?: boolean }
  | ({ type: '_contextSnapshot' } & ContextSnapshotEvent)
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



const CHATBOT_MODE = 'chatbot'

const emptyContextView = (userId = ''): ContextView => ({
  userId,
  version:        0,
  recentMessages: [],
  userContext:    null,
  modeSummaries:  {},
  toolSummaries:  [],
})

const buildSystemPrompt = (basePrompt: string | undefined): string => {
  const todayDateNote = `Today's date is ${new Date().toDateString()}.`
  return [basePrompt, todayDateNote, HISTORY_MARKERS_NOTE].filter(Boolean).join('\n\n---\n\n')
}

const assembleUserText = (
  text:         string,
  attachments?: MessageAttachment[],
): string => {
  let out = text
  if (!attachments || attachments.length === 0) return out

  const images = attachments.filter(a => a.kind === 'image').map(a => a.url)
  if (images.length > 0) {
    const note = images.length === 1
      ? `[Image attached: "${images[0]}"] `
      : `[Images attached: ${images.map(p => `"${p}"`).join(', ')}]`
    out = out ? `${out}\n\n${note}` : note
  }

  const audio = attachments.filter(a => a.kind === 'audio').map(a => a.url)
  if (audio.length > 0) {
    const note = audio.length === 1
      ? `[Audio attached: "${audio[0]}"]`
      : `[Audio files attached: ${audio.map(p => `"${p}"`).join(', ')}]`
    out = out ? `${out}\n\n${note}` : note
  }

  const pdfs = attachments.filter(a => a.kind === 'pdf').map(a => a.url)
  if (pdfs.length > 0) {
    const note = pdfs.length === 1
      ? `[PDF attached: "${pdfs[0]}"] `
      : `[PDFs attached: ${pdfs.map(p => `"${p}"`).join(', ')}]`
    out = out ? `${out}\n\n${note}` : note
  }

  return out
}

const initialChatbotState = (): ChatbotState => ({
  loop:           idleLoopState(),
  contextView:    emptyContextView(),
  tools:          {},
  sessionUsage:   { promptTokens: 0, completionTokens: 0 },
  activeClientId: '',
})

export const ChatbotAgentFactory = (config: ChatbotAgentConfig) =>
  (opts: AgentFactoryOpts): ActorDef<ChatbotMsg, ChatbotState> => Chatbot(config, opts)

export const Chatbot = (
  config: ChatbotAgentConfig,
  opts:   AgentFactoryOpts,
): ActorDef<ChatbotMsg, ChatbotState> => {
  const { model, systemPrompt, toolFilter, maxToolLoops = 25 } = config
  const { userId, contextStoreRef, llmRef } = opts

  type M   = ChatbotMsg
  type S   = ChatbotState
  type Ctx = ActorContext<M>

  const contextSnapshot = (state: S, msg: Extract<M, { type: '_contextSnapshot' }>): ActorResult<M, S> => {
    return {
      state: {
        ...state,
        contextView: {
          userId:         msg.userId,
          version:        msg.version,
          recentMessages: msg.recentMessages,
          userContext:    msg.userContext,
          modeSummaries:  msg.modeSummaries,
          toolSummaries:  msg.toolSummaries,
        },
      },
    }
  }

  const buildTurnMessages = (state: S, userMessage: ApiMessage): ApiMessage[] =>
    assembleAgentMessages(state.contextView, {
      mode:                      CHATBOT_MODE,
      systemPrompt:              buildSystemPrompt(systemPrompt),
      includeUserContext:        true,
      includeCurrentModeSummary: true,
      includeOtherModeSummaries: true,
      includeToolSummaries:      true,
    }, userMessage)


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
      contextStoreRef.send({ type: 'append', mode: CHATBOT_MODE, messages })
      return { state }
    },

    onComplete: (state, finalText, usage, ctx) => {
      if (finalText) {
        contextStoreRef.send({ type: 'append', mode: CHATBOT_MODE, source: 'assistant', clientId: state.activeClientId, messages: [{ role: 'assistant', content: finalText }] })
      }

      const sessionUsage: TokenUsage = {
        promptTokens:     state.sessionUsage.promptTokens     + usage.promptTokens,
        completionTokens: state.sessionUsage.completionTokens + usage.completionTokens,
      }

      return {
        state: { ...state, sessionUsage },
      }
    },

    onError: (state, err, ctx) => {
      if (err.kind === 'loopLimit') {
        ctx.log.warn('chatbot: tool loop limit reached', { clientId: state.activeClientId })
      }
      return { state }
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
    const stateNext: S = {
      ...state,
      activeClientId: clientId,
    }

    contextStoreRef.send({ type: 'append', mode: CHATBOT_MODE, source: 'user', clientId, injected: isInjected, messages: [userMessage] })

    return loop.startTurn(stateNext, {
      messages: buildTurnMessages(stateNext, userMessage),
      userId,
      clientId,
    }, ctx)
  }

  const handleUserMessage = (state: S, msg: Extract<M, { type: 'userMessage' }>, ctx: Ctx): ActorResult<M, S> => {
    const { clientId: msgClientId, text, attachments, isCron, isInjected } = msg
    const userText = isCron ? `[Internal Instruction] ${text}` : assembleUserText(text, attachments)
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

    if (m.type === '_contextSnapshot') {
      return contextSnapshot(state, m as Extract<M, { type: '_contextSnapshot' }>)
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

        ctx.subscribe(ContextSnapshotTopic, (event) => {
          if (event.userId !== userId) return null
          return {
            type: '_contextSnapshot' as const,
            ...event,
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
