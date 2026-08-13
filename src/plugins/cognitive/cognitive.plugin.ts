import { createPluginFactory, AgentSpawner } from '../../system/index.ts'
import type { ActorRef } from '../../system/index.ts'
import { SessionManager } from './session-manager.ts'
import { LlmProvider } from './llm-provider.ts'
import { OpenRouterAdapter } from './adapters/openrouter.ts'
import { VeniceAdapter } from './adapters/venice.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import type { SessionConfig, UserContextMsg } from './types.ts'
import { UserContext } from './user-context.ts'
import { AgentRegistry } from './agent-registry.ts'
import { ChatbotAgentDescriptor } from './chatbot-agent.ts'
import { buildCognitiveRoutes } from './cognitive.routes.ts'
import { config, defaultConfig, type CognitiveConfig } from './cognitive.config.ts'

// ─── Config types ───

type LlmProviderConfig = NonNullable<CognitiveConfig['llmProvider']>

export default createPluginFactory<CognitiveConfig>({
  id: 'cognitive',
  version: '2.0.0',
  description: 'Cognitive actors: LLM provider, agent registry, session manager, chatbot + planner agents',
  configDescriptor: config,
  maskKeys: ['apiKey'],
  slots: {
    llmProvider: {
      factory: (cfg: LlmProviderConfig) => {
        if (!cfg || !cfg.apiKey) return null
        if (cfg.provider === 'venice') {
          return LlmProvider({
            adapter: VeniceAdapter({
              apiKey: cfg.apiKey,
              baseUrl: cfg.baseUrl,
            }),
          })
        }
        return LlmProvider({ adapter: OpenRouterAdapter({ apiKey: cfg.apiKey, reasoning: cfg.reasoning }) })
      },
      configPath: 'llmProvider',
    },
    agentSpawner: {
      factory: (cfg, deps) => {
        if (!deps.llmProvider) return null
        return AgentSpawner({
          llmRef: deps.llmProvider as ActorRef<LlmProviderMsg>,
        })
      },
      dependsOn: ['llmProvider'],
    },
    agentRegistry: {
      factory: () => AgentRegistry(),
    },
    sessionManager: {
      factory: (cfg, deps) => {
        if (!deps.llmProvider || !deps.agentRegistry) return null
        const sessionConfig = cfg.session ?? defaultConfig.session!
        return SessionManager({
          llmRef:             deps.llmProvider as ActorRef<LlmProviderMsg>,
          agentRegistryRef:   deps.agentRegistry as ActorRef<any>,
          defaultMode:        sessionConfig.defaultMode,
          contextWindowHours: sessionConfig.contextWindowHours,
          persistContext:     sessionConfig.persistContext ?? false,
        })
      },
      dependsOn: ['llmProvider', 'agentRegistry'],
    },
    userContext: {
      factory: (cfg) => {
        if (!cfg.userContext) return null
        return UserContext({
          model: cfg.userContext.model,
          intervalMs: cfg.userContext.intervalMs,
        })
      },
    },
  },
  agents: {
    chatbot: {
      factory: ChatbotAgentDescriptor,
      options: (cfg) => ({
        model:        cfg.chatbot?.model ?? 'deepseek/deepseek-v4-flash',
        systemPrompt: cfg.chatbot?.systemPrompt,
        toolFilter:   cfg.chatbot?.toolFilter,
        agentSCRs: [
          'scr:leaf:registry.search',
          'scr:leaf:registry.get',
          'scr:leaf:tools.web_search'
        ],
      }),
    },
  },
  routes: (cfg, deps) => {
    return buildCognitiveRoutes(deps.llmProvider as ActorRef<LlmProviderMsg>)
  },
})
