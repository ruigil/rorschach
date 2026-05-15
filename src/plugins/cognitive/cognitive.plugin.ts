import { SessionManager } from './session-manager.ts'
import { LlmProvider, OpenRouterAdapter } from './llm-provider.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import type { ToolFilter } from '../../types/tools.ts'
import type { PlannerConfig, SessionConfig } from './types.ts'
import { AgentRegistry } from './agent-registry.ts'
import {
  AgentRegistrationTopic,
  type AgentDescriptor,
} from './types.ts'
import { ChatbotAgentFactory } from './chatbot.ts'
import { PlannerAgentFactory, type PlannerAgentConfig } from './planner-agent.ts'
import { defineConfig, createSlot, stopSlot, type ActorSlot } from '../../system/config.ts'
import type { ActorContext, ActorRef, PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { redact } from '../../system/types.ts'
import { ConfigSchemaTopic } from '../../types/config.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import { cognitiveSchemas, buildCognitiveConfigRoute } from './routes.ts'

// ─── Config types ───

type LlmProviderConfig = {
  apiKey: string
  reasoning?: { enabled?: boolean; effort?: 'high' | 'medium' | 'low' | 'minimal' }
}

type ChatbotConfig = {
  model:         string
  systemPrompt?: string
  toolFilter?:   ToolFilter
}

export type CognitiveConfig = {
  llmProvider?: LlmProviderConfig
  chatbot?:     ChatbotConfig
  planner?:     PlannerConfig
  session?:     SessionConfig
}

const config = defineConfig<CognitiveConfig>('cognitive', {})

// ─── Plugin internals ───

type PluginMsg = { type: 'config'; slice: CognitiveConfig | undefined }

type PluginState = {
  initialized:    boolean
  llmProvider:    ActorSlot<LlmProviderConfig>
  agentRegistry:  ActorSlot<never>
  sessionManager: ActorSlot<never>
  planner:        ActorSlot<PlannerConfig>
  chatbot:        ActorSlot<ChatbotConfig>
  session:        ActorSlot<SessionConfig>
}

const EMPTY_STATE: PluginState = {
  initialized:    true,
  llmProvider:    createSlot(),
  agentRegistry:  createSlot(),
  sessionManager: createSlot(),
  planner:        createSlot(),
  chatbot:        createSlot(),
  session:        createSlot(),
}

type ResolvedPlannerConfig = {
  model:        string
  plansDir:     string
  maxToolLoops: number
  toolFilter?:  PlannerAgentConfig['toolFilter']
}

const PLANNER_DEFAULTS: ResolvedPlannerConfig = {
  model:        'google/gemini-2.5-flash-lite-preview',
  plansDir:     'workspace/plans',
  maxToolLoops: 10,
  toolFilter:   { allow: ['switch_mode','web_search', 'fetch_file'] },
}

const resolvePlannerConfig = (cfg: PlannerConfig | null): ResolvedPlannerConfig =>
  cfg ? { ...PLANNER_DEFAULTS, ...cfg } : { ...PLANNER_DEFAULTS }


const resolveSessionConfig = (cfg: SessionConfig | null): SessionConfig => ({
  defaultMode:        cfg?.defaultMode ?? 'chatbot',
  historyWindowHours: cfg?.historyWindowHours ?? 4,
})

// ─── Descriptor builders ───

const buildChatbotDescriptor = (cfg: ChatbotConfig): AgentDescriptor => ({
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

const buildPlannerDescriptor = (cfg: ResolvedPlannerConfig): AgentDescriptor => ({
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
  chatbotConfig: ChatbotConfig | null,
  plannerConfig: PlannerConfig | null,
  sessionConfig: SessionConfig | null,
  gen: number,
): Omit<PluginState, 'initialized'> => {

  const llmProviderRef = ctx.spawn(
    `llm-provider-${gen}`,
    LlmProvider({ adapter: OpenRouterAdapter({ apiKey: llmProviderConfig.apiKey, reasoning: llmProviderConfig.reasoning }) }),
  ) as ActorRef<LlmProviderMsg>
  ctx.publishRetained(LlmProviderTopic, 'ref', { ref: llmProviderRef })

  const agentRegistryRef = ctx.spawn(`agent-registry-${gen}`, AgentRegistry())

  const resolvedSession = resolveSessionConfig(sessionConfig)
  const sessionManagerRef = chatbotConfig
    ? ctx.spawn(
        `session-manager-${gen}`,
        SessionManager({
          llmRef:             llmProviderRef,
          defaultMode:        resolvedSession.defaultMode,
          historyWindowHours: resolvedSession.historyWindowHours,
        }),
      )
    : null

  // Register built-in agents.
  if (chatbotConfig) {
    ctx.publish(AgentRegistrationTopic, { type: 'register', descriptor: buildChatbotDescriptor(chatbotConfig) })
  }
  ctx.publish(AgentRegistrationTopic, { type: 'register', descriptor: buildPlannerDescriptor(resolvePlannerConfig(plannerConfig)) })

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
      const slice = ctx.initialConfig() as CognitiveConfig | undefined
      const llmProviderConfig = slice?.llmProvider ?? null
      const chatbotConfig     = slice?.chatbot     ?? null
      const plannerConfig     = slice?.planner     ?? null
      const sessionConfig     = slice?.session     ?? null

      // Publish config schemas and config route
      for (const section of cognitiveSchemas) {
        ctx.publishRetained(ConfigSchemaTopic, section.id, section)
      }
      for (const reg of buildCognitiveConfigRoute(() => slice)) {
        ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
      }

      if (!llmProviderConfig) {
        ctx.log.info('cognitive plugin activated (no llmProvider config)')
        return { state: EMPTY_STATE }
      }

      const children = spawnAll(ctx, llmProviderConfig, chatbotConfig, plannerConfig, sessionConfig, 0)
      ctx.log.info('cognitive plugin activated')
      return { state: { initialized: true, ...children } }
    },

    stopped: (state, ctx) => {
      ctx.log.info('cognitive plugin deactivating')
      ctx.deleteRetained(LlmProviderTopic, 'ref', { ref: null })
      // Tombstone config schemas and config route
      for (const section of cognitiveSchemas) {
        ctx.deleteRetained(ConfigSchemaTopic, section.id, { ...section, schema: null })
      }
      for (const reg of buildCognitiveConfigRoute(() => undefined)) {
        ctx.deleteRetained(RouteRegistrationTopic, reg.id, { id: reg.id, method: reg.method, path: reg.path, handler: null })
      }
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
      const newLlmProviderConfig = msg.slice?.llmProvider ?? null
      const newChatbotConfig     = msg.slice?.chatbot     ?? null
      const newPlannerConfig     = msg.slice?.planner     ?? null
      const newSessionConfig     = msg.slice?.session     ?? null

      // Stop all existing actors
      if (state.llmProvider.ref)    ctx.stop(state.llmProvider.ref)
      if (state.agentRegistry.ref)  ctx.stop(state.agentRegistry.ref)
      if (state.sessionManager.ref) ctx.stop(state.sessionManager.ref)

      ctx.deleteRetained(LlmProviderTopic, 'ref', { ref: null })

      // No LLM provider → tear everything down.
      if (!newLlmProviderConfig) {
        return { state: { ...EMPTY_STATE, initialized: true } }
      }

      // Respawn everything with new config
      const gen = state.llmProvider.gen + 1
      const children = spawnAll(ctx, newLlmProviderConfig, newChatbotConfig, newPlannerConfig, newSessionConfig, gen)

      return { state: { initialized: true, ...children } }
    },
  }),
}

export default cognitivePlugin
