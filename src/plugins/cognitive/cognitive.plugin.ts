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
import type { ActorContext, ActorRef, PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { redact } from '../../system/types.ts'

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

// ─── Plugin internals ───

type PluginMsg = { type: 'config'; slice: CognitiveConfig | undefined }

type PluginState = {
  initialized:    boolean
  llmProvider:    { config: LlmProviderConfig | null; ref: ActorRef<LlmProviderMsg> | null; gen: number }
  agentRegistry:  { ref: ActorRef<any>                | null; gen: number }
  sessionManager: { ref: ActorRef<any>                | null; gen: number }
  planner:        { config: PlannerConfig | null;     gen: number }
  chatbot:        { config: ChatbotConfig | null;     gen: number }
  session:        { config: SessionConfig | null;     gen: number }
}

const EMPTY_STATE: PluginState = {
  initialized:    true,
  llmProvider:    { config: null, ref: null, gen: 0 },
  agentRegistry:  { ref: null, gen: 0 },
  sessionManager: { ref: null, gen: 0 },
  planner:        { config: null, gen: 0 },
  chatbot:        { config: null, gen: 0 },
  session:        { config: null, gen: 0 },
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
  toolFilter:   { allow: ['web_search', 'fetch_file'] },
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
    agentRegistry:  { ref: agentRegistryRef, gen },
    sessionManager: { ref: sessionManagerRef, gen },
    planner:        { config: plannerConfig, gen },
    chatbot:        { config: chatbotConfig, gen },
    session:        { config: sessionConfig, gen },
  }
}

const cognitivePlugin: PluginDef<PluginMsg, PluginState, CognitiveConfig> = {
  id: 'cognitive',
  version: '2.0.0',
  description: 'Cognitive actors: LLM provider, agent registry, session manager, chatbot + planner agents',
  configDescriptor: {
    defaults: {},
    onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
  },

  initialState: {
    initialized:    false,
    llmProvider:    { config: null, ref: null, gen: 0 },
    agentRegistry:  { ref: null, gen: 0 },
    sessionManager: { ref: null, gen: 0 },
    planner:        { config: null, gen: 0 },
    chatbot:        { config: null, gen: 0 },
    session:        { config: null, gen: 0 },
  },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.initialConfig() as CognitiveConfig | undefined
      const llmProviderConfig = slice?.llmProvider ?? null
      const chatbotConfig     = slice?.chatbot     ?? null
      const plannerConfig     = slice?.planner     ?? null
      const sessionConfig     = slice?.session     ?? null

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

      const llmProviderChanged = JSON.stringify(newLlmProviderConfig) !== JSON.stringify(state.llmProvider.config)
      const chatbotChanged     = JSON.stringify(newChatbotConfig)     !== JSON.stringify(state.chatbot.config)
      const plannerChanged     = JSON.stringify(newPlannerConfig)     !== JSON.stringify(state.planner.config)
      const sessionChanged     = JSON.stringify(newSessionConfig)     !== JSON.stringify(state.session.config)

      if (!llmProviderChanged && !chatbotChanged && !plannerChanged && !sessionChanged) return { state }

      const gen = state.llmProvider.gen + 1

      // No LLM provider → tear everything down.
      if (!newLlmProviderConfig) {
        if (state.llmProvider.ref)    ctx.stop(state.llmProvider.ref)
        if (state.agentRegistry.ref)  ctx.stop(state.agentRegistry.ref)
        if (state.sessionManager.ref) ctx.stop(state.sessionManager.ref)
        ctx.publishRetained(LlmProviderTopic, 'ref', { ref: null })
        return { state: { ...state, ...EMPTY_STATE, initialized: true } }
      }

      // Restart LLM provider if its config changed.
      let llmProviderRef: ActorRef<LlmProviderMsg> | null = state.llmProvider.ref
      let llmProviderState = state.llmProvider
      if (llmProviderChanged) {
        if (state.llmProvider.ref) ctx.stop(state.llmProvider.ref)
        llmProviderRef = ctx.spawn(
          `llm-provider-${gen}`,
          LlmProvider({ adapter: OpenRouterAdapter({ apiKey: newLlmProviderConfig.apiKey, reasoning: newLlmProviderConfig.reasoning }) }),
        ) as ActorRef<LlmProviderMsg>
        ctx.publishRetained(LlmProviderTopic, 'ref', { ref: llmProviderRef })
        llmProviderState = { config: newLlmProviderConfig, ref: llmProviderRef, gen }
      }

      // Restart session-manager if chatbot OR session config changed.
      const needsSessionManagerRespawn = chatbotChanged || sessionChanged
      let sessionManagerState = state.sessionManager
      let chatbotState        = state.chatbot
      let sessionState        = state.session
      if (needsSessionManagerRespawn) {
        if (state.sessionManager.ref) ctx.stop(state.sessionManager.ref)
        const resolvedSession = resolveSessionConfig(newSessionConfig)
        const sessionManagerRef = newChatbotConfig
          ? ctx.spawn(
              `session-manager-${gen}`,
              SessionManager({
                llmRef:             llmProviderRef!,
                defaultMode:        resolvedSession.defaultMode,
                historyWindowHours: resolvedSession.historyWindowHours,
              }),
            )
          : null
        sessionManagerState = { ref: sessionManagerRef, gen }
        sessionState        = { config: newSessionConfig, gen }

        // Re-register chatbot descriptor only when the chatbot config itself changed.
        if (chatbotChanged) {
          if (newChatbotConfig) {
            ctx.publish(AgentRegistrationTopic, { type: 'register', descriptor: buildChatbotDescriptor(newChatbotConfig) })
          } else {
            ctx.publish(AgentRegistrationTopic, { type: 'unregister', mode: 'chatbot' })
          }
          chatbotState = { config: newChatbotConfig, gen }
        }
      }

      // Re-register planner descriptor with new config. The formalize-plan
      // tool actor is owned by each planner instance, so no plugin-level
      // respawn is needed.
      let plannerState = state.planner
      if (plannerChanged) {
        ctx.publish(AgentRegistrationTopic, {
          type: 'register',
          descriptor: buildPlannerDescriptor(resolvePlannerConfig(newPlannerConfig)),
        })
        plannerState = { config: newPlannerConfig, gen }
      }

      return {
        state: {
          ...state,
          llmProvider:    llmProviderState,
          sessionManager: sessionManagerState,
          planner:        plannerState,
          chatbot:        chatbotState,
          session:        sessionState,
        },
      }
    },
  }),
}

export default cognitivePlugin
