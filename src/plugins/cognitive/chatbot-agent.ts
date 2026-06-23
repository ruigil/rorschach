import type { ActorDef, ActorRef, ActorContext, ActorResult, Interceptor } from '../../system/index.ts'
import { onLifecycle } from '../../system/index.ts'
import { agentLoop, idleLoopState, type LoopState } from '../../system/index.ts'
import { OutboundUserMessageTopic } from '../../types/events.ts'
import type { ToolCollection, ToolFilter, ToolMsg } from '../../types/tools.ts'
import { applyToolFilter } from '../../system/index.ts'
import { ToolRegistrationTopic } from '../../types/tools.ts'
import type { ApiMessage } from '../../types/llm.ts'
import { ContextSnapshotTopic, type AgentFactoryOpts, type AgentModelOptions } from '../../types/agents.ts'
import { assembleAgentMessages, assembleUserText, getTodayDateString, type ContextView } from '../../system/index.ts'
import type { ChatbotMsg } from './types.ts'

// ─── State ───

export type ChatbotState = {
  loop:           LoopState
  contextView:    ContextView
  tools:          ToolCollection
}

export type ChatbotAgentConfig = AgentModelOptions & {
  systemPrompt?: string
}



const CHATBOT_MODE = 'chatbot'

const emptyContextView = (userId = ''): ContextView => ({
  userId,
  version:        0,
  recentMessages: [],
  userContext:    null,
  toolSummaries:  [],
})

const buildSystemPrompt = (basePrompt: string | undefined): string => {
  const todayDateNote = `Today's date is ${getTodayDateString('local')}.`
  return [basePrompt, todayDateNote].filter(Boolean).join('\n\n---\n\n')
}



export const ChatbotAgentFactory = (options: ChatbotAgentConfig) =>
  (opts: AgentFactoryOpts): ActorDef<ChatbotMsg, ChatbotState> => Chatbot(options, opts)

export const Chatbot = (
  options: ChatbotAgentConfig,
  opts:   AgentFactoryOpts,
): ActorDef<ChatbotMsg, ChatbotState> => {
  const { model, systemPrompt, toolFilter, maxToolLoops = 25 } = options
  const { userId, contextStoreRef, llmRef } = opts

  type M   = ChatbotMsg
  type S   = ChatbotState
  type Ctx = ActorContext<M>

  const handleContextSnapshot = (state: S, msg: Extract<M, { type: '_contextSnapshot' }>): ActorResult<M, S> => {
    return {
      state: {
        ...state,
        contextView: {
          userId:         msg.userId,
          version:        msg.version,
          recentMessages: msg.recentMessages,
          userContext:    msg.userContext,
          toolSummaries:  msg.toolSummaries,
        },
      },
    }
  }

  const handleToolRegistered = (state: S, msg: Extract<M, { type: '_toolRegistered' }>): ActorResult<M, S> => {
    return {
      state: {
        ...state,
        tools: {
          ...state.tools,
          [msg.name]: { name: msg.name, schema: msg.schema, ref: msg.ref, mayBeLongRunning: msg.mayBeLongRunning },
        },
      },
    }
  }

  const handleToolUnregistered = (state: S, msg: Extract<M, { type: '_toolUnregistered' }>): ActorResult<M, S> => {
    const { [msg.name]: _, ...rest } = state.tools
    return { state: { ...state, tools: rest } }
  }

  const buildTurnMessages = (state: S, userMessage: ApiMessage): ApiMessage[] =>
    assembleAgentMessages(state.contextView, {
      mode:                      CHATBOT_MODE,
      systemPrompt:              buildSystemPrompt(systemPrompt),
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

    uiEvents:      OutboundUserMessageTopic,
    errorMessages: {
      llm:      'Something went wrong. Please try again.',
      loopLimit: 'Tool loop limit reached. Please try again.',
    },

    onBatchHistoryReady: (state, messages) => {
      contextStoreRef.send({ type: 'append', mode: CHATBOT_MODE, messages })
      return { state }
    },

	    onComplete: (state, finalText) => {
      if (finalText) {
        contextStoreRef.send({ type: 'append', mode: CHATBOT_MODE, source: 'assistant', messages: [{ role: 'assistant', content: finalText }] })
      }
      return { state }
    },

	    onError: (state, err, ctx) => {
	      if (err.kind === 'loopLimit') {
	        ctx.log.warn('chatbot: tool loop limit reached')
	      }
	      return { state }
	    },

	    onToolPending: (state, pending) => {
	      const text = pending.placeholderText ?? `Background job started for ${pending.toolName} (jobId=${pending.jobId}).`
	      contextStoreRef.send({
	        type: 'append',
	        mode: CHATBOT_MODE,
	        source: 'assistant',
	        messages: [{ role: 'assistant', content: text }],
	      })
	      return { state }
	    },
	  })

  const doStartTurn = (
    state: S,
    userText: string,
    isInjected: boolean,
    ctx: Ctx,
  ): ActorResult<M, S> => {
    const userMessage: ApiMessage = { role: 'user', content: userText }

    contextStoreRef.send({ type: 'append', mode: CHATBOT_MODE, source: 'user', injected: isInjected, messages: [userMessage] })

    return loop.startTurn(state, {
      messages: buildTurnMessages(state, userMessage),
      userId,
    }, ctx)
  }

  const handleUserMessage = (state: S, msg: Extract<M, { type: 'userMessage' }>, ctx: Ctx): ActorResult<M, S> => {
    const { text, attachments, isInjected } = msg
    const userText = assembleUserText(text, attachments)
    return doStartTurn(state, userText, isInjected || false, ctx)
  }

  const hostInterceptor: Interceptor<M, S> = (state, msg, ctx, next) => {
    const m = msg as M

    if (m.type === '_contextSnapshot') {
      return handleContextSnapshot(state, m as Extract<M, { type: '_contextSnapshot' }>)
    }

    if (m.type === 'userMessage') {
      if (state.loop.phase !== 'idle') return { state, stash: true }
      return handleUserMessage(state, m as Extract<M, { type: 'userMessage' }>, ctx)
    }

    if (m.type === '_toolRegistered') {
      return handleToolRegistered(state, m as Extract<M, { type: '_toolRegistered' }>)
    }

    if (m.type === '_toolUnregistered') {
      return handleToolUnregistered(state, m as Extract<M, { type: '_toolUnregistered' }>)
    }

    return next(state, msg)
  }

  return {
    initialState: () => ({
      loop:           idleLoopState(),
      contextView:    emptyContextView(userId),
      tools:          {},
    }),
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
    stashCapacity: 100,

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
