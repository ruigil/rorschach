import { createChatbotActor, type ChatbotActorOptions } from './chatbot.ts'
import type { ActorIdentity, PluginDef } from '../../system/types.ts'
import { onLifecycle } from '../../system/match.ts'
import { redact } from '../../system/types.ts'

export type CognitiveConfig = {
  chatbot?: ChatbotActorOptions
}

type PluginMsg = { type: 'config'; slice: CognitiveConfig | undefined }
type PluginState = { initialized: boolean; chatbotConfig: ChatbotActorOptions | null; chatbotRef: ActorIdentity | null; chatbotGen: number }

const cognitivePlugin: PluginDef<PluginMsg, PluginState, CognitiveConfig> = {
  id: 'cognitive',
  version: '1.0.0',
  description: 'Cognitive actors: LLM-backed chatbot',
  dependencies: ['tools'],

  configDescriptor: {
    defaults: {},
    onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
  },

  initialState: { initialized: false, chatbotConfig: null, chatbotRef: null, chatbotGen: 0 },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.config as CognitiveConfig | undefined

      const chatbotConfig = slice?.chatbot ?? null
      const chatbotRef = chatbotConfig
        ? ctx.spawn('chatbot-0', createChatbotActor(chatbotConfig), { history: {}, pending: {}, pendingBatch: {}, toolsRef: null, spanHandles: {} })
        : null

      ctx.log.info('cognitive plugin activated')
      return { state: { initialized: true, chatbotConfig, chatbotRef, chatbotGen: 0 } }
    },
    stopped: (state, ctx) => {
      ctx.log.info('cognitive plugin deactivating')
      return { state }
    },
  }),

  maskState: (state) => ({
    ...state,
    chatbotConfig: state.chatbotConfig ? { ...state.chatbotConfig, apiKey: redact() } : null,
  }),

  handler: (state, msg, ctx) => {
    if (state.chatbotRef) ctx.stop(state.chatbotRef)
    const newChatbot = msg.slice?.chatbot ?? null
    const chatbotGen = state.chatbotGen + 1
    const chatbotRef = newChatbot
      ? ctx.spawn(`chatbot-${chatbotGen}`, createChatbotActor(newChatbot), { history: {}, pending: {}, pendingBatch: {}, toolsRef: null, spanHandles: {} })
      : null
    return { state: { ...state, chatbotConfig: newChatbot, chatbotRef, chatbotGen } }
  },
}

export default cognitivePlugin
