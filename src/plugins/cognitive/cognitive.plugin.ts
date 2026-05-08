import { createSessionManagerActor } from './session-manager.ts'
import { createLlmProviderActor, createOpenRouterAdapter } from './llm-provider.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import type { ToolFilter, ToolMsg } from '../../types/tools.ts'
import { ToolRegistrationTopic } from '../../types/tools.ts'
import type { PlannerConfig } from './types.ts'
import { createPlannerSupervisorActor, createInitialPlannerSupervisorState, PLAN_TOOL_SCHEMA } from './planner-agent.ts'
import type { PlannerToolOptions } from './planner-agent.ts'
import type { ActorContext, ActorRef, PluginDef } from '../../system/types.ts'
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
  historyWindowHours?: number
  toolFilter?:    ToolFilter
}

export type CognitiveConfig = {
  llmProvider?: LlmProviderConfig
  chatbot?:     ChatbotConfig
  planner?:     PlannerConfig
}

// ─── Plugin internals ───

type PluginMsg = { type: 'config'; slice: CognitiveConfig | undefined }

type PluginState = {
  initialized:    boolean
  llmProvider:    { config: LlmProviderConfig | null; ref: ActorRef<LlmProviderMsg> | null; gen: number }
  sessionManager: { config: ChatbotConfig | null;     ref: ActorRef<any> | null; gen: number }
  planner:        { config: PlannerConfig | null;     ref: ActorRef<ToolMsg> | null; gen: number }
}

const EMPTY_STATE: PluginState = {
  initialized:    true,
  llmProvider:    { config: null, ref: null, gen: 0 },
  sessionManager: { config: null, ref: null, gen: 0 },
  planner:        { config: null, ref: null, gen: 0 },
}

const PLANNER_DEFAULTS: PlannerToolOptions = {
  model:        'google/gemini-2.5-flash-lite-preview',
  plansDir:     'workspace/plans',
  maxToolLoops: 10,
  toolFilter:   { allow: ['web_search', 'fetch_file'] },
}

const mergePlannerConfig = (cfg: PlannerConfig | null): PlannerToolOptions =>
  cfg ? { ...PLANNER_DEFAULTS, ...cfg } : { ...PLANNER_DEFAULTS }

const spawnAll = (
  ctx: ActorContext<PluginMsg>,
  llmProviderConfig: LlmProviderConfig,
  chatbotConfig: ChatbotConfig | null,
  plannerConfig: PlannerConfig | null,
  gen: number,
): Omit<PluginState, 'initialized'> => {
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
          llmRef:        llmProviderRef,
          model:         chatbotConfig.model,
          systemPrompt:  chatbotConfig.systemPrompt,
          historyWindowHours: chatbotConfig.historyWindowHours,
          toolFilter:    chatbotConfig.toolFilter,
        }),
        { userSessions: {}, clientIndex: {}, activeClients: {}, plannerSessions: {} },
      )
    : null

  const effectivePlannerConfig = mergePlannerConfig(plannerConfig)
  const plannerRef = ctx.spawn(
    `plan-tool-${gen}`,
    createPlannerSupervisorActor(effectivePlannerConfig),
    createInitialPlannerSupervisorState(),
  ) as ActorRef<ToolMsg>
  ctx.publishRetained(ToolRegistrationTopic, 'plan', {
    name: 'plan', schema: PLAN_TOOL_SCHEMA as any,
    ref: plannerRef, mayBeLongRunning: true,
  })

  return {
    llmProvider:    { config: llmProviderConfig, ref: llmProviderRef, gen },
    sessionManager: { config: chatbotConfig,     ref: sessionManagerRef, gen },
    planner:        { config: plannerConfig,     ref: plannerRef, gen },
  }
}

const cognitivePlugin: PluginDef<PluginMsg, PluginState, CognitiveConfig> = {
  id: 'cognitive',
  version: '1.0.0',
  description: 'Cognitive actors: LLM provider, chatbot actor and session management',
  configDescriptor: {
    defaults: {},
    onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
  },

  initialState: {
    initialized:    false,
    llmProvider:    { config: null, ref: null, gen: 0 },
    sessionManager: { config: null, ref: null, gen: 0 },
    planner:        { config: null, ref: null, gen: 0 },
  },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.initialConfig() as CognitiveConfig | undefined
      const llmProviderConfig = slice?.llmProvider ?? null
      const chatbotConfig     = slice?.chatbot     ?? null
      const plannerConfig     = slice?.planner     ?? null

      if (!llmProviderConfig) {
        ctx.log.info('cognitive plugin activated (no llmProvider config)')
        return { state: EMPTY_STATE }
      }

      const children = spawnAll(ctx, llmProviderConfig, chatbotConfig, plannerConfig, 0)
      ctx.log.info('cognitive plugin activated')
      return { state: { initialized: true, ...children } }
    },

    stopped: (_state, ctx) => {
      ctx.log.info('cognitive plugin deactivating')
      ctx.deleteRetained(LlmProviderTopic, 'ref', { ref: null })
      ctx.deleteRetained(ToolRegistrationTopic, 'plan', { name: 'plan', ref: null })
      return { state: _state }
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

      const llmProviderChanged = JSON.stringify(newLlmProviderConfig) !== JSON.stringify(state.llmProvider.config)
      const chatbotChanged     = JSON.stringify(newChatbotConfig)     !== JSON.stringify(state.sessionManager.config)
      const plannerChanged     = JSON.stringify(newPlannerConfig)     !== JSON.stringify(state.planner.config)

      if (!llmProviderChanged && !chatbotChanged && !plannerChanged) return { state }

      const gen = state.llmProvider.gen + 1

      // No LLM provider → stop everything
      if (!newLlmProviderConfig) {
        if (state.llmProvider.ref)    ctx.stop(state.llmProvider.ref)
        if (state.sessionManager.ref) ctx.stop(state.sessionManager.ref)
        if (state.planner.ref) {
          ctx.stop(state.planner.ref)
          ctx.deleteRetained(ToolRegistrationTopic, 'plan', { name: 'plan', ref: null })
        }
        ctx.publishRetained(LlmProviderTopic, 'ref', { ref: null })
        return { state: { ...state, ...EMPTY_STATE, initialized: true } }
      }

      // Restart LLM provider if its config changed
      let llmProviderRef: ActorRef<LlmProviderMsg> | null = state.llmProvider.ref
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
                llmRef:        llmProviderRef!,
                model:         newChatbotConfig.model,
                systemPrompt:  newChatbotConfig.systemPrompt,
                historyWindowHours: newChatbotConfig.historyWindowHours,
                toolFilter:    newChatbotConfig.toolFilter,
              }),
              { userSessions: {}, clientIndex: {}, activeClients: {}, plannerSessions: {} },
            )
          : null
        sessionManagerState = { config: newChatbotConfig, ref: sessionManagerRef, gen }
      }

      // Restart planner if its config changed
      let plannerState = state.planner
      if (plannerChanged) {
        if (state.planner.ref) {
          ctx.stop(state.planner.ref)
          ctx.deleteRetained(ToolRegistrationTopic, 'plan', { name: 'plan', ref: null })
        }
        const effectivePlannerConfig = mergePlannerConfig(newPlannerConfig)
        const plannerRef = ctx.spawn(
          `plan-tool-${gen}`,
          createPlannerSupervisorActor(effectivePlannerConfig),
          createInitialPlannerSupervisorState(),
        ) as ActorRef<ToolMsg>
        ctx.publishRetained(ToolRegistrationTopic, 'plan', {
          name: 'plan', schema: PLAN_TOOL_SCHEMA as any,
          ref: plannerRef, mayBeLongRunning: true,
        })
        plannerState = { config: newPlannerConfig, ref: plannerRef, gen }
      }

      return { state: { ...state, llmProvider: llmProviderState, sessionManager: sessionManagerState, planner: plannerState } }
    },
  }),
}

export default cognitivePlugin
