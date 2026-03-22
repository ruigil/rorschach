import { createChatbotActor } from './chatbot.ts'
import { createLlmProviderActor, createOpenRouterAdapter } from './llm-provider.ts'
import type { LlmProviderMsg } from './llm-provider.ts'
import type { ActorContext, ActorIdentity, ActorRef, PluginDef } from '../../system/types.ts'
import { onLifecycle } from '../../system/match.ts'
import { redact } from '../../system/types.ts'

// ─── Config types ───

type LlmProviderConfig = {
  apiKey: string
  model: string
  reasoning?: { enabled?: boolean; effort?: 'high' | 'medium' | 'low' | 'minimal' }
}

type ChatbotConfig = {
  systemPrompt?: string
}

export type CognitiveConfig = {
  llmProvider?: LlmProviderConfig
  chatbot?: ChatbotConfig
}

// ─── Plugin internals ───

type PluginMsg = { type: 'config'; slice: CognitiveConfig | undefined }

type PluginState = {
  initialized: boolean
  llmProviderConfig: LlmProviderConfig | null
  llmProviderRef: ActorRef<LlmProviderMsg> | null
  chatbotConfig: ChatbotConfig | null
  chatbotRef: ActorIdentity | null
  gen: number
}

const INITIAL_CHATBOT_STATE = {
  history: {}, pending: {}, pendingReasoning: {}, pendingBatch: {},
  toolsRef: null, spanHandles: {}, sessionUsage: {}, pendingUsage: {},
  modelInfo: null, requestMap: {}, llmRequests: {},
}

const spawnPair = (
  ctx: ActorContext<PluginMsg>,
  llmProviderConfig: LlmProviderConfig,
  chatbotConfig: ChatbotConfig | null,
  gen: number,
): { llmProviderRef: ActorRef<LlmProviderMsg>; chatbotRef: ActorIdentity | null } => {
  const llmProviderRef = ctx.spawn(
    `llm-provider-${gen}`,
    createLlmProviderActor({ adapter: createOpenRouterAdapter(llmProviderConfig) }),
    null,
  )

  const chatbotRef = chatbotConfig
    ? ctx.spawn(
        `chatbot-${gen}`,
        createChatbotActor({
          llmRef: llmProviderRef,
          model: llmProviderConfig.model,
          systemPrompt: chatbotConfig.systemPrompt,
        }),
        INITIAL_CHATBOT_STATE,
      )
    : null

  return { llmProviderRef, chatbotRef }
}

const cognitivePlugin: PluginDef<PluginMsg, PluginState, CognitiveConfig> = {
  id: 'cognitive',
  version: '1.0.0',
  description: 'Cognitive actors: LLM-backed chatbot',
  dependencies: ['tools'],

  configDescriptor: {
    defaults: {},
    onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
  },

  initialState: {
    initialized: false,
    llmProviderConfig: null,
    llmProviderRef: null,
    chatbotConfig: null,
    chatbotRef: null,
    gen: 0,
  },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.config as CognitiveConfig | undefined
      const llmProviderConfig = slice?.llmProvider ?? null
      const chatbotConfig = slice?.chatbot ?? null

      if (!llmProviderConfig) {
        ctx.log.info('cognitive plugin activated (no llmProvider config)')
        return { state: { initialized: true, llmProviderConfig: null, llmProviderRef: null, chatbotConfig: null, chatbotRef: null, gen: 0 } }
      }

      const { llmProviderRef, chatbotRef } = spawnPair(ctx, llmProviderConfig, chatbotConfig, 0)
      ctx.log.info('cognitive plugin activated')
      return { state: { initialized: true, llmProviderConfig, llmProviderRef, chatbotConfig, chatbotRef, gen: 0 } }
    },
    stopped: (state, ctx) => {
      ctx.log.info('cognitive plugin deactivating')
      return { state }
    },
  }),

  maskState: (state) => ({
    ...state,
    llmProviderConfig: state.llmProviderConfig
      ? { ...state.llmProviderConfig, apiKey: redact() }
      : null,
  }),

  handler: (state, msg, ctx) => {
    if (state.chatbotRef) ctx.stop(state.chatbotRef)
    if (state.llmProviderRef) ctx.stop(state.llmProviderRef)

    const newLlmProviderConfig = msg.slice?.llmProvider ?? null
    const newChatbotConfig = msg.slice?.chatbot ?? null
    const gen = state.gen + 1

    if (!newLlmProviderConfig) {
      return { state: { ...state, llmProviderConfig: null, llmProviderRef: null, chatbotConfig: null, chatbotRef: null, gen } }
    }

    const { llmProviderRef, chatbotRef } = spawnPair(ctx, newLlmProviderConfig, newChatbotConfig, gen)
    return { state: { ...state, llmProviderConfig: newLlmProviderConfig, llmProviderRef, chatbotConfig: newChatbotConfig, chatbotRef, gen } }
  },
}

export default cognitivePlugin
