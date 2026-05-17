import { SessionManager } from './session-manager.ts'
import { LlmProvider, OpenRouterAdapter } from './llm-provider.ts'
import { LlmProviderTopic, type LlmProviderMsg } from '../../types/llm.ts'
import type { ToolFilter } from '../../types/tools.ts'
import type { SessionConfig } from './types.ts'
import type { AgentDescriptor } from '../../types/agents.ts'
import { AgentRegistry } from './agent-registry.ts'
import { AgentRegistrationTopic } from '../../types/agents.ts'
import { ChatbotAgentFactory, type ChatbotAgentConfig } from './chatbot-agent.ts'
import { PlannerAgentFactory, type PlannerAgentConfig } from './planner-agent.ts'
import { defineConfig, createSlot, publishConfigSurface, deleteConfigSurface, type ActorSlot } from '../../system/plugin-config.ts'
import type { ActorContext, ActorRef, PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { redact } from '../../system/types.ts'
import { cognitiveSchemas } from './routes.ts'

// ─── Config types ───

type LlmProviderConfig = {
  apiKey: string
  reasoning?: { enabled?: boolean; effort?: 'high' | 'medium' | 'low' | 'minimal' }
}


export type CognitiveConfig = {
  llmProvider?: LlmProviderConfig
  chatbot?:     ChatbotAgentConfig
  planner?:     PlannerAgentConfig
  session?:     SessionConfig
}

type ResolvedCognitiveConfig = CognitiveConfig & {
  chatbot: ChatbotAgentConfig
  session: SessionConfig
}

const defaultConfig: CognitiveConfig = {
  chatbot: {
    model: 'deepseek/deepseek-v4-flash',
  },
  session: {
    defaultMode:        'chatbot',
    historyWindowHours: 4,
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
  planner:        ActorSlot<PlannerAgentConfig>
  chatbot:        ActorSlot<ChatbotAgentConfig>
  session:        ActorSlot<SessionConfig>
}

const initialState: PluginState = {
  initialized:    true,
  llmProvider:    createSlot(),
  agentRegistry:  createSlot(),
  sessionManager: createSlot(),
  planner:        createSlot(),
  chatbot:        createSlot(),
  session:        createSlot(),
}

// ─── Descriptor builders ───

const buildChatbotDescriptor = (cfg: ChatbotAgentConfig): AgentDescriptor => ({
  mode:         'chatbot',
  displayName:  'Chatbot',
  shortDesc:    'General-purpose conversational assistant',
  factory:      ChatbotAgentFactory({
    model:        cfg.model,
    systemPrompt: cfg.systemPrompt,
    toolFilter:   cfg.toolFilter,
  }),
  capabilities: { userVisible: true },
})

const buildPlannerDescriptor = (cfg: PlannerAgentConfig): AgentDescriptor => ({
  mode:         'planner',
  displayName:  'Planner',
  shortDesc:    'Structured planning of multi-step goals',
  factory:      PlannerAgentFactory({
    model:        cfg.model,
    maxToolLoops: cfg.maxToolLoops,
    toolFilter:   cfg.toolFilter,
    plansDir:     cfg.plansDir,
  }),
  capabilities: { userVisible: true },
})

// ─── Spawn helpers ───

const spawnAll = (
  ctx: ActorContext<PluginMsg>,
  llmProviderConfig: LlmProviderConfig,
  chatbotConfig: ChatbotAgentConfig,
  plannerConfig: PlannerAgentConfig | null,
  sessionConfig: SessionConfig,
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
      historyWindowHours: sessionConfig.historyWindowHours,
    }),
  )

  // Register built-in agents.
  ctx.publish(AgentRegistrationTopic, { type: 'register', descriptor: buildChatbotDescriptor(chatbotConfig) })
  if (plannerConfig) {
    ctx.publish(AgentRegistrationTopic, { type: 'register', descriptor: buildPlannerDescriptor(plannerConfig) })
  }

  return {
    llmProvider:    { config: llmProviderConfig, ref: llmProviderRef, gen },
    agentRegistry:  { config: null, ref: agentRegistryRef, gen },
    sessionManager: { config: null, ref: sessionManagerRef, gen },
    planner:        { config: plannerConfig, ref: null, gen },
    chatbot:        { config: chatbotConfig, ref: null, gen },
    session:        { config: sessionConfig, ref: null, gen },
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
    planner:        createSlot(),
    chatbot:        createSlot(),
    session:        createSlot(),
  },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.initialConfig() as ResolvedCognitiveConfig
      const llmProviderConfig = slice.llmProvider ?? null
      const plannerConfig     = slice.planner ?? null

      publishConfigSurface(ctx, config, () => slice)

      if (!llmProviderConfig) {
        ctx.log.info('cognitive plugin activated (no llmProvider config)')
        return { state: initialState }
      }

      const children = spawnAll(ctx, llmProviderConfig, slice.chatbot, plannerConfig, slice.session, 0)
      ctx.log.info('cognitive plugin activated')
      return { state: { initialized: true, ...children } }
    },

    stopped: (state, ctx) => {
      ctx.log.info('cognitive plugin deactivating')
      ctx.deleteRetained(LlmProviderTopic, 'ref', { ref: null })
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
      const newPlannerConfig     = slice?.planner ?? null

      // Stop all existing actors
      if (state.llmProvider.ref)    ctx.stop(state.llmProvider.ref)
      if (state.agentRegistry.ref)  ctx.stop(state.agentRegistry.ref)
      if (state.sessionManager.ref) ctx.stop(state.sessionManager.ref)

      ctx.deleteRetained(LlmProviderTopic, 'ref', { ref: null })

      // No LLM provider → tear everything down.
      if (!newLlmProviderConfig) {
        return { state: { ...initialState, initialized: true } }
      }

      // Respawn everything with new config
      const gen = state.llmProvider.gen + 1
      const resolvedSlice = slice as ResolvedCognitiveConfig
      const children = spawnAll(ctx, newLlmProviderConfig, resolvedSlice.chatbot, newPlannerConfig, resolvedSlice.session, gen)

      return { state: { initialized: true, ...children } }
    },
  }),
}

export default cognitivePlugin
