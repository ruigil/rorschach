import { createSessionManagerActor } from './session-manager.ts'
import { createLlmProviderActor, createOpenRouterAdapter } from './llm-provider.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import type { ActorContext, ActorRef, PluginActorState, PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { redact } from '../../system/types.ts'

// ─── Config types ───

type LlmProviderConfig = {
  apiKey: string
  reasoning?: { enabled?: boolean; effort?: 'high' | 'medium' | 'low' | 'minimal' }
}

type ChatbotConfig = {
  model:          string
  systemPrompt?:  string
  historyWindow?: number
  toolFilter?:    { allow: string[] } | { deny: string[] }
}

export type CognitiveConfig = {
  llmProvider?: LlmProviderConfig
  chatbot?: ChatbotConfig
}

// ─── Plugin internals ───

type PluginMsg = { type: 'config'; slice: CognitiveConfig | undefined }

type PluginState = {
  initialized: boolean
  llmProvider: PluginActorState<LlmProviderConfig>
  sessionManager: PluginActorState<ChatbotConfig>
}

const EMPTY_STATE: PluginState = {
  initialized: true,
  llmProvider:    { config: null, ref: null, gen: 0 },
  sessionManager: { config: null, ref: null, gen: 0 },
}

const spawnAll = (
  ctx: ActorContext<PluginMsg>,
  llmProviderConfig: LlmProviderConfig,
  chatbotConfig: ChatbotConfig | null,
  gen: number,
): Pick<PluginState, 'llmProvider' | 'sessionManager'> => {
  
  const llmProviderRef = ctx.spawn(
    `llm-provider-${gen}`,
    createLlmProviderActor({ adapter: createOpenRouterAdapter({ apiKey: llmProviderConfig.apiKey, reasoning: llmProviderConfig.reasoning }) }),
    null,
  ) as ActorRef<LlmProviderMsg>
  ctx.publishRetained(LlmProviderTopic, 'ref', { ref: llmProviderRef })

  const sessionManagerRef = chatbotConfig
    ? ctx.spawn(
        `session-manager-${gen}`,
        createSessionManagerActor({
          llmRef: llmProviderRef,
          model: chatbotConfig.model,
          systemPrompt: chatbotConfig.systemPrompt,
          historyWindow: chatbotConfig.historyWindow,
          toolFilter: chatbotConfig.toolFilter,
        }),
        { sessions: {} },
      )
    : null

  return {
    llmProvider:    { config: llmProviderConfig, ref: llmProviderRef, gen },
    sessionManager: { config: chatbotConfig,     ref: sessionManagerRef, gen },
  }
}

const cognitivePlugin: PluginDef<PluginMsg, PluginState, CognitiveConfig> = {
  id: 'cognitive',
  version: '1.0.0',
  description: 'Cognitive actors: LLM provider, ReAct loop and session management',
  configDescriptor: {
    defaults: {},
    onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
  },

  initialState: {
    initialized: false,
    llmProvider:    { config: null, ref: null, gen: 0 },
    sessionManager: { config: null, ref: null, gen: 0 },
  },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.initialConfig() as CognitiveConfig | undefined
      const llmProviderConfig = slice?.llmProvider ?? null
      const chatbotConfig = slice?.chatbot ?? null

      if (!llmProviderConfig) {
        ctx.log.info('cognitive plugin activated (no llmProvider config)')
        return { state: EMPTY_STATE }
      }

      const children = spawnAll(ctx, llmProviderConfig, chatbotConfig, 0)
      ctx.log.info('cognitive plugin activated')
      return { state: { initialized: true, ...children } }
    },

    stopped: (state, ctx) => {
      ctx.log.info('cognitive plugin deactivating')
      ctx.deleteRetained(LlmProviderTopic, 'ref', { ref: null })
      return { state }
    },
  }),

  maskState: (state) => ({
    ...state,
    llmProvider: state.llmProvider.config
      ? { ...state.llmProvider, config: { ...state.llmProvider.config, apiKey: redact() } }
      : state.llmProvider,
  }),

  handler: onMessage<PluginMsg, PluginState>({
    config: (state, msg, ctx) => {
      const newLlmProviderConfig = msg.slice?.llmProvider ?? null
      const newChatbotConfig    = msg.slice?.chatbot     ?? null

      const llmProviderChanged = JSON.stringify(newLlmProviderConfig) !== JSON.stringify(state.llmProvider.config)
      const chatbotChanged     = JSON.stringify(newChatbotConfig)     !== JSON.stringify(state.sessionManager.config)

      if (!llmProviderChanged && !chatbotChanged) return { state }

      const gen = state.llmProvider.gen + 1

      // No LLM provider → stop everything
      if (!newLlmProviderConfig) {
        if (state.llmProvider.ref)    ctx.stop(state.llmProvider.ref)
        if (state.sessionManager.ref) ctx.stop(state.sessionManager.ref)
        ctx.publishRetained(LlmProviderTopic, 'ref', { ref: null })
        return { state: { ...state, ...EMPTY_STATE, initialized: true } }
      }

      // Restart LLM provider if its config changed
      let llmProviderRef: ActorRef<LlmProviderMsg> | null = state.llmProvider.ref as ActorRef<LlmProviderMsg> | null
      let llmProviderState = state.llmProvider
      if (llmProviderChanged) {
        if (state.llmProvider.ref) ctx.stop(state.llmProvider.ref)
        llmProviderRef = ctx.spawn(
          `llm-provider-${gen}`,
          createLlmProviderActor({ adapter: createOpenRouterAdapter({ apiKey: newLlmProviderConfig.apiKey, reasoning: newLlmProviderConfig.reasoning }) }),
          null,
        ) as ActorRef<LlmProviderMsg>
        ctx.publishRetained(LlmProviderTopic, 'ref', { ref: llmProviderRef })
        llmProviderState = { config: newLlmProviderConfig, ref: llmProviderRef, gen }
      }

      // Restart session manager if its config changed
      let sessionManagerState = state.sessionManager
      if (chatbotChanged) {
        if (state.sessionManager.ref) ctx.stop(state.sessionManager.ref)
        const sessionManagerRef = newChatbotConfig
          ? ctx.spawn(
              `session-manager-${gen}`,
              createSessionManagerActor({
                llmRef: llmProviderRef!,
                model: newChatbotConfig.model,
                systemPrompt: newChatbotConfig.systemPrompt,
                historyWindow: newChatbotConfig.historyWindow,
                toolFilter: newChatbotConfig.toolFilter,
              }),
              { sessions: {} },
            )
          : null
        sessionManagerState = { config: newChatbotConfig, ref: sessionManagerRef, gen }
      }

      return { state: { ...state, llmProvider: llmProviderState, sessionManager: sessionManagerState } }
    },
  }),
}

export default cognitivePlugin
