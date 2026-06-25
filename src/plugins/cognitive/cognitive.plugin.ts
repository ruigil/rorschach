import { createPluginFactory, defineConfig } from '../../system/index.ts'
import type { ActorRef } from '../../system/index.ts'
import { SessionManager } from './session-manager.ts'
import { LlmProvider, OpenRouterAdapter } from './llm-provider.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import type { SessionConfig, UserContextMsg } from './types.ts'
import { UserContext } from './user-context.ts'
import { AgentRegistry } from './agent-registry.ts'
import { ChatbotAgentFactory, type ChatbotAgentOptions } from './chatbot-agent.ts'
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
        return LlmProvider({ adapter: OpenRouterAdapter({ apiKey: cfg.apiKey, reasoning: cfg.reasoning }) })
      },
      configPath: 'llmProvider',
    },
    agentRegistry: {
      factory: () => AgentRegistry(),
    },
    sessionManager: {
      factory: (cfg, deps) => {
        if (!deps.llmProvider) return null
        const sessionConfig = cfg.session ?? defaultConfig.session!
        return SessionManager({
          llmRef:             deps.llmProvider as ActorRef<LlmProviderMsg>,
          defaultMode:        sessionConfig.defaultMode,
          contextWindowHours: sessionConfig.contextWindowHours,
          contextPath:        sessionConfig.contextPath,
        })
      },
      dependsOn: ['llmProvider'],
    },
    userContext: {
      factory: (cfg) => {
        if (!cfg.userContext) return null
        const sessionConfig = cfg.session ?? defaultConfig.session!
        return UserContext({
          model: cfg.userContext.model,
          intervalMs: cfg.userContext.intervalMs,
          contextPath: sessionConfig.contextPath,
        })
      },
    },
  },
  agents: {
    chatbot: {
      factory: ChatbotAgentFactory,
      options: (cfg) => ({
        model:        cfg.chatbot?.model ?? 'deepseek/deepseek-v4-flash',
        systemPrompt: cfg.chatbot?.systemPrompt,
        toolFilter:   cfg.chatbot?.toolFilter,
      }),
    },
  },
})
