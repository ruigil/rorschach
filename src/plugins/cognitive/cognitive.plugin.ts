import { createSessionManagerActor } from './session-manager.ts'
import { createLlmProviderActor, createOpenRouterAdapter, LlmProviderTopic } from './llm-provider.ts'
import type { LlmProviderMsg } from './llm-provider.ts'
import { createVisionActor, ANALYZE_IMAGE_TOOL_NAME, ANALYZE_IMAGE_SCHEMA } from './vision-actor.ts'
import type { ActorContext, ActorIdentity, ActorRef, PluginDef } from '../../system/types.ts'
import { ToolRegistrationTopic } from '../../system/tools.ts'
import type { ToolInvokeMsg } from '../../system/tools.ts'
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

type VisionActorConfig = {
  model: string
}

export type CognitiveConfig = {
  llmProvider?: LlmProviderConfig
  chatbot?: ChatbotConfig
  visionActor?: VisionActorConfig
}

// ─── Plugin internals ───

type PluginMsg = { type: 'config'; slice: CognitiveConfig | undefined }

type PluginState = {
  initialized: boolean
  llmProviderConfig: LlmProviderConfig | null
  llmProviderRef: ActorRef<LlmProviderMsg> | null
  chatbotConfig: ChatbotConfig | null
  sessionManagerRef: ActorIdentity | null
  visionConfig: VisionActorConfig | null
  visionRef: ActorIdentity | null
  gen: number
}

const spawnAll = (
  ctx: ActorContext<PluginMsg>,
  llmProviderConfig: LlmProviderConfig,
  chatbotConfig: ChatbotConfig | null,
  visionConfig: VisionActorConfig | null,
  gen: number,
): { llmProviderRef: ActorRef<LlmProviderMsg>; sessionManagerRef: ActorIdentity | null; visionRef: ActorIdentity | null } => {
  const llmProviderRef = ctx.spawn(
    `llm-provider-${gen}`,
    createLlmProviderActor({ adapter: createOpenRouterAdapter({ apiKey: llmProviderConfig.apiKey, reasoning: llmProviderConfig.reasoning }) }),
    null,
  )
  ctx.publishRetained(LlmProviderTopic, 'ref', { ref: llmProviderRef })

  const sessionManagerRef = chatbotConfig
    ? ctx.spawn(
        `session-manager-${gen}`,
        createSessionManagerActor({
          llmRef: llmProviderRef,
          model: llmProviderConfig.model,
          systemPrompt: chatbotConfig.systemPrompt,
        }),
        { sessions: {} },
      )
    : null

  let visionRef: ActorIdentity | null = null
  if (visionConfig) {
    const ref = ctx.spawn(
      `vision-actor-${gen}`,
      createVisionActor({ llmRef: llmProviderRef, model: visionConfig.model }),
      { pending: {} },
    )
    ctx.publishRetained(ToolRegistrationTopic, ANALYZE_IMAGE_TOOL_NAME, {
      name: ANALYZE_IMAGE_TOOL_NAME,
      schema: ANALYZE_IMAGE_SCHEMA,
      ref: ref as unknown as ActorRef<ToolInvokeMsg>,
    })
    visionRef = ref
  }

  return { llmProviderRef, sessionManagerRef, visionRef }
}

const cognitivePlugin: PluginDef<PluginMsg, PluginState, CognitiveConfig> = {
  id: 'cognitive',
  version: '1.0.0',
  description: 'Cognitive actors: LLM-backed chatbot',
  subscribesTo: ['tools', 'memory'],

  configDescriptor: {
    defaults: {},
    onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
  },

  initialState: {
    initialized: false,
    llmProviderConfig: null,
    llmProviderRef: null,
    chatbotConfig: null,
    sessionManagerRef: null,
    visionConfig: null,
    visionRef: null,
    gen: 0,
  },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.config as CognitiveConfig | undefined
      const llmProviderConfig = slice?.llmProvider ?? null
      const chatbotConfig = slice?.chatbot ?? null
      const visionConfig = slice?.visionActor ?? null

      if (!llmProviderConfig) {
        ctx.log.info('cognitive plugin activated (no llmProvider config)')
        return { state: { initialized: true, llmProviderConfig: null, llmProviderRef: null, chatbotConfig: null, sessionManagerRef: null, visionConfig: null, visionRef: null, gen: 0 } }
      }

      const { llmProviderRef, sessionManagerRef, visionRef } = spawnAll(ctx, llmProviderConfig, chatbotConfig, visionConfig, 0)
      ctx.log.info('cognitive plugin activated')
      return { state: { initialized: true, llmProviderConfig, llmProviderRef, chatbotConfig, sessionManagerRef, visionConfig, visionRef, gen: 0 } }
    },
    stopped: (state, ctx) => {
      ctx.log.info('cognitive plugin deactivating')
      ctx.deleteRetained(LlmProviderTopic, 'ref', { ref: null })
      if (state.visionRef) {
        ctx.deleteRetained(ToolRegistrationTopic, ANALYZE_IMAGE_TOOL_NAME, { name: ANALYZE_IMAGE_TOOL_NAME, ref: null })
      }
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
    if (state.sessionManagerRef) ctx.stop(state.sessionManagerRef)
    if (state.llmProviderRef) ctx.stop(state.llmProviderRef)
    if (state.visionRef) {
      ctx.stop(state.visionRef)
      ctx.deleteRetained(ToolRegistrationTopic, ANALYZE_IMAGE_TOOL_NAME, { name: ANALYZE_IMAGE_TOOL_NAME, ref: null })
    }

    const newLlmProviderConfig = msg.slice?.llmProvider ?? null
    const newChatbotConfig = msg.slice?.chatbot ?? null
    const newVisionConfig = msg.slice?.visionActor ?? null
    const gen = state.gen + 1

    if (!newLlmProviderConfig) {
      return { state: { ...state, llmProviderConfig: null, llmProviderRef: null, chatbotConfig: null, sessionManagerRef: null, visionConfig: null, visionRef: null, gen } }
    }

    const { llmProviderRef, sessionManagerRef, visionRef } = spawnAll(ctx, newLlmProviderConfig, newChatbotConfig, newVisionConfig, gen)
    return { state: { ...state, llmProviderConfig: newLlmProviderConfig, llmProviderRef, chatbotConfig: newChatbotConfig, sessionManagerRef, visionConfig: newVisionConfig, visionRef, gen } }
  },
}

export default cognitivePlugin
