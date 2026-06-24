import { SessionManager } from './session-manager.ts'
import { LlmProvider, OpenRouterAdapter } from './llm-provider.ts'
import { LlmProviderTopic, type LlmProviderMsg } from '../../types/llm.ts'
import type { SessionConfig, UserContextMsg } from './types.ts'
import { UserContext } from './user-context.ts'
import type { AgentDescriptor } from '../../types/agents.ts'
import { AgentRegistry } from './agent-registry.ts'
import { AgentRegistrationTopic } from '../../types/agents.ts'
import { ChatbotAgentFactory, type ChatbotAgentOptions } from './chatbot-agent.ts'
import { defineConfig, createSlot, stopSlot, publishConfigSurface, deleteConfigSurface, type ActorSlot } from '../../system/index.ts'
import type { ActorContext, ActorRef, PluginDef } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { redact } from '../../system/index.ts'
import { cognitiveSchemas } from './routes.ts'

// ─── Config types ───

type LlmProviderConfig = {
  apiKey: string
  reasoning?: { enabled?: boolean; effort?: 'high' | 'medium' | 'low' | 'minimal' }
}

export type UserContextConfig = {
  model:      string
  intervalMs: number
}

export type CognitiveConfig = {
  llmProvider?: LlmProviderConfig
  chatbot?:     ChatbotAgentOptions
  session?:     SessionConfig
  userContext?: UserContextConfig
}

type ResolvedCognitiveConfig = CognitiveConfig & {
  chatbot: ChatbotAgentOptions
  session: SessionConfig
}

const defaultConfig: CognitiveConfig = {
  chatbot: {
    model: 'deepseek/deepseek-v4-flash',
  },
  session: {
    defaultMode:        'chatbot',
    contextWindowHours: 4,
    contextPath:        'workspace/context',
  },
  userContext: {
    model:      'deepseek/deepseek-v4-flash',
    intervalMs: 60_000,
  },
}

const config = defineConfig<CognitiveConfig>('cognitive', defaultConfig, {
  schemas: cognitiveSchemas,
})

// ─── Plugin internals ───

type PluginMsg = { type: 'config'; slice: CognitiveConfig | undefined }

type PluginState = {
  initialized:    boolean
  llmProvider:    ActorSlot<LlmProviderConfig>
  agentRegistry:  ActorSlot<never>
  sessionManager: ActorSlot<never>
  chatbot:        ActorSlot<ChatbotAgentOptions>
  session:        ActorSlot<SessionConfig>
  userContext:    ActorSlot<UserContextConfig>
}

const initialState: PluginState = {
  initialized:    true,
  llmProvider:    createSlot(),
  agentRegistry:  createSlot(),
  sessionManager: createSlot(),
  chatbot:        createSlot(),
  session:        createSlot(),
  userContext:    createSlot(),
}



// ─── Spawn helpers ───

const spawnAll = (
  ctx: ActorContext<PluginMsg>,
  llmProviderConfig: LlmProviderConfig,
  chatbotConfig: ChatbotAgentOptions,
  sessionConfig: SessionConfig,
  userContextConfig: UserContextConfig | null,
  contextPath: string | undefined,
  gen: number,
): Omit<PluginState, 'initialized'> => {

  const llmProviderRef = ctx.spawn(
    `llm-provider-${gen}`,
    LlmProvider({ adapter: OpenRouterAdapter({ apiKey: llmProviderConfig.apiKey, reasoning: llmProviderConfig.reasoning }) }),
  ) as ActorRef<LlmProviderMsg>
  ctx.publishRetained(LlmProviderTopic, 'ref', { ref: llmProviderRef })

  const agentRegistryRef = ctx.spawn(`agent-registry-${gen}`, AgentRegistry())

  const sessionManagerRef = ctx.spawn(
    `session-manager-${gen}`,
    SessionManager({
      llmRef:             llmProviderRef,
      defaultMode:        sessionConfig.defaultMode,
      contextWindowHours: sessionConfig.contextWindowHours,
      contextPath,
    }),
  )

  let userContextRef: ActorRef<UserContextMsg> | null = null
  if (userContextConfig) {
    userContextRef = ctx.spawn(
      `user-context-${gen}`,
      UserContext({ model: userContextConfig.model, intervalMs: userContextConfig.intervalMs, contextPath }),
    )
  }

  // Register built-in agents.
  ctx.publish(AgentRegistrationTopic, {
    type: 'register',
    descriptor: ChatbotAgentFactory({
      model:        chatbotConfig.model,
      systemPrompt: chatbotConfig.systemPrompt,
      toolFilter:   chatbotConfig.toolFilter,
    })
  })

  return {
    llmProvider:    { config: llmProviderConfig, ref: llmProviderRef, gen },
    agentRegistry:  { config: null, ref: agentRegistryRef, gen },
    sessionManager: { config: null, ref: sessionManagerRef, gen },
    chatbot:        { config: chatbotConfig, ref: null, gen },
    session:        { config: sessionConfig, ref: null, gen },
    userContext:    { config: userContextConfig, ref: userContextRef, gen },
  }
}

const cognitivePlugin: PluginDef<PluginMsg, PluginState, CognitiveConfig> = {
  id: 'cognitive',
  version: '2.0.0',
  description: 'Cognitive actors: LLM provider, agent registry, session manager, chatbot + planner agents',

  configDescriptor: config,

  initialState: {
    initialized:    false,
    llmProvider:    createSlot(),
    agentRegistry:  createSlot(),
    sessionManager: createSlot(),
    chatbot:        createSlot(),
    session:        createSlot(),
    userContext:    createSlot(),
  },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.initialConfig() as ResolvedCognitiveConfig
      const llmProviderConfig = slice.llmProvider ?? null
      const userContextConfig = slice.userContext ?? null
      const contextPath       = slice.session.contextPath

      publishConfigSurface(ctx, config, () => slice)

      if (!llmProviderConfig) {
        ctx.log.info('cognitive plugin activated (no llmProvider config)')
        return { state: initialState }
      }

      const children = spawnAll(ctx, llmProviderConfig, slice.chatbot, slice.session, userContextConfig, contextPath, 0)
      ctx.log.info('cognitive plugin activated')
      return { state: { initialized: true, ...children } }
    },

    stopped: (state, ctx) => {
      ctx.log.info('cognitive plugin deactivating')
      ctx.deleteRetained(LlmProviderTopic, 'ref', { ref: null })
      stopSlot(ctx, state.llmProvider)
      stopSlot(ctx, state.agentRegistry)
      stopSlot(ctx, state.sessionManager)
      stopSlot(ctx, state.userContext)
      deleteConfigSurface(ctx, config)
      // AgentRegistry's own stopped lifecycle clears AgentCatalogTopic + switchMode tool registration.
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
      const slice = msg.slice as ResolvedCognitiveConfig | undefined
      const newLlmProviderConfig = slice?.llmProvider ?? null
      const newUserContextConfig = slice?.userContext ?? null
      const newContextPath       = slice?.session?.contextPath

      // No LLM provider → tear everything down.
      if (!newLlmProviderConfig) {
        if (state.llmProvider.ref)    ctx.stop(state.llmProvider.ref)
        if (state.agentRegistry.ref)  ctx.stop(state.agentRegistry.ref)
        if (state.sessionManager.ref) ctx.stop(state.sessionManager.ref)
        if (state.userContext.ref)    ctx.stop(state.userContext.ref)
        ctx.deleteRetained(LlmProviderTopic, 'ref', { ref: null })
        return { state: { ...initialState, initialized: true } }
      }

      // Check what changed
      const chatbotChanged = JSON.stringify(state.chatbot.config) !== JSON.stringify(slice?.chatbot)
      const sessionChanged = JSON.stringify(state.session.config) !== JSON.stringify(slice?.session)
      const userContextChanged = JSON.stringify(state.userContext.config) !== JSON.stringify(slice?.userContext)
      const llmProviderChanged = JSON.stringify(state.llmProvider.config) !== JSON.stringify(slice?.llmProvider)

      if (chatbotChanged || sessionChanged || userContextChanged || !state.sessionManager.ref) {
        // Structural changes: perform full restart of all child actors
        if (state.llmProvider.ref)    ctx.stop(state.llmProvider.ref)
        if (state.agentRegistry.ref)  ctx.stop(state.agentRegistry.ref)
        if (state.sessionManager.ref) ctx.stop(state.sessionManager.ref)
        if (state.userContext.ref)    ctx.stop(state.userContext.ref)
        ctx.deleteRetained(LlmProviderTopic, 'ref', { ref: null })

        const gen = state.llmProvider.gen + 1
        const resolvedSlice = slice as ResolvedCognitiveConfig
        const children = spawnAll(ctx, newLlmProviderConfig, resolvedSlice.chatbot, resolvedSlice.session, newUserContextConfig, newContextPath, gen)
        return { state: { initialized: true, ...children } }
      }

      if (llmProviderChanged) {
        // Only the LLM Provider configuration changed. Recreate only the LLM Provider in-place.
        if (state.llmProvider.ref) ctx.stop(state.llmProvider.ref)
        ctx.deleteRetained(LlmProviderTopic, 'ref', { ref: null })

        const gen = state.llmProvider.gen + 1
        const llmProviderRef = ctx.spawn(
          `llm-provider-${gen}`,
          LlmProvider({ adapter: OpenRouterAdapter({ apiKey: newLlmProviderConfig.apiKey, reasoning: newLlmProviderConfig.reasoning }) }),
        ) as ActorRef<LlmProviderMsg>
        ctx.publishRetained(LlmProviderTopic, 'ref', { ref: llmProviderRef })

        return {
          state: {
            ...state,
            llmProvider: { config: newLlmProviderConfig, ref: llmProviderRef, gen },
          }
        }
      }

      return { state }
    },
  }),
}

export default cognitivePlugin
