import { createSessionManagerActor } from './session-manager.ts'
import { createLlmProviderActor, createOpenRouterAdapter, LlmProviderTopic } from './llm-provider.ts'
import type { LlmProviderMsg } from './llm-provider.ts'
import { createVisionActor, ANALYZE_IMAGE_TOOL_NAME, ANALYZE_IMAGE_SCHEMA } from './vision-actor.ts'
import type { ActorContext, ActorRef, PluginActorState, PluginDef } from '../../system/types.ts'
import { ToolRegistrationTopic } from '../../system/tools.ts'
import type { ToolInvokeMsg } from '../../system/tools.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
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
  llmProvider: PluginActorState<LlmProviderConfig>
  sessionManager: PluginActorState<ChatbotConfig>
  vision: PluginActorState<VisionActorConfig>
}

const EMPTY_STATE: PluginState = {
  initialized: true,
  llmProvider:    { config: null, ref: null, gen: 0 },
  sessionManager: { config: null, ref: null, gen: 0 },
  vision:         { config: null, ref: null, gen: 0 },
}

const spawnAll = (
  ctx: ActorContext<PluginMsg>,
  llmProviderConfig: LlmProviderConfig,
  chatbotConfig: ChatbotConfig | null,
  visionConfig: VisionActorConfig | null,
  gen: number,
): Pick<PluginState, 'llmProvider' | 'sessionManager' | 'vision'> => {
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
          model: llmProviderConfig.model,
          systemPrompt: chatbotConfig.systemPrompt,
        }),
        { sessions: {} },
      )
    : null

  let visionRef = null
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

  return {
    llmProvider:    { config: llmProviderConfig, ref: llmProviderRef, gen },
    sessionManager: { config: chatbotConfig,     ref: sessionManagerRef, gen },
    vision:         { config: visionConfig,       ref: visionRef, gen },
  }
}

const cognitivePlugin: PluginDef<PluginMsg, PluginState, CognitiveConfig> = {
  id: 'cognitive',
  version: '1.0.0',
  description: 'Cognitive actors: LLM-backed chatbot',
  precedes: ['tools', 'memory'],

  configDescriptor: {
    defaults: {},
    onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
  },

  initialState: {
    initialized: false,
    llmProvider:    { config: null, ref: null, gen: 0 },
    sessionManager: { config: null, ref: null, gen: 0 },
    vision:         { config: null, ref: null, gen: 0 },
  },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.config as CognitiveConfig | undefined
      const llmProviderConfig = slice?.llmProvider ?? null
      const chatbotConfig = slice?.chatbot ?? null
      const visionConfig = slice?.visionActor ?? null

      if (!llmProviderConfig) {
        ctx.log.info('cognitive plugin activated (no llmProvider config)')
        return { state: EMPTY_STATE }
      }

      const children = spawnAll(ctx, llmProviderConfig, chatbotConfig, visionConfig, 0)
      ctx.log.info('cognitive plugin activated')
      return { state: { initialized: true, ...children } }
    },

    stopped: (state, ctx) => {
      ctx.log.info('cognitive plugin deactivating')
      ctx.deleteRetained(LlmProviderTopic, 'ref', { ref: null })
      if (state.vision.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, ANALYZE_IMAGE_TOOL_NAME, { name: ANALYZE_IMAGE_TOOL_NAME, ref: null })
      }
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
      if (state.sessionManager.ref) ctx.stop(state.sessionManager.ref)
      if (state.llmProvider.ref)    ctx.stop(state.llmProvider.ref)
      if (state.vision.ref) {
        ctx.stop(state.vision.ref)
        ctx.deleteRetained(ToolRegistrationTopic, ANALYZE_IMAGE_TOOL_NAME, { name: ANALYZE_IMAGE_TOOL_NAME, ref: null })
      }

      const newLlmProviderConfig = msg.slice?.llmProvider ?? null
      const newChatbotConfig     = msg.slice?.chatbot ?? null
      const newVisionConfig      = msg.slice?.visionActor ?? null
      const gen = state.llmProvider.gen + 1

      if (!newLlmProviderConfig) {
        return { state: { ...state, ...EMPTY_STATE, initialized: true } }
      }

      const children = spawnAll(ctx, newLlmProviderConfig, newChatbotConfig, newVisionConfig, gen)
      return { state: { ...state, ...children } }
    },
  }),
}

export default cognitivePlugin
