import { createChatbotActor, type ChatbotActorOptions } from './chatbot.ts'
import type { ActorIdentity, PluginDef } from '../../system/types.ts'
import { onLifecycle } from '../../system/match.ts'

export type CognitiveConfig = {
  chatbot?: ChatbotActorOptions
}

type PluginMsg = { type: 'config'; slice: CognitiveConfig | undefined }
type PluginState = { initialized: boolean; chatbotConfig: ChatbotActorOptions | null; chatbotRef: ActorIdentity | null; chatbotGen: number }

const cognitivePlugin: PluginDef<PluginMsg, PluginState, CognitiveConfig> = {
  id: 'cognitive',
  version: '1.0.0',
  description: 'Cognitive actors: LLM-backed chatbot',

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
        ? ctx.spawn('chatbot-0', createChatbotActor(chatbotConfig), { history: {}, pending: {} })
        : null

      ctx.log.info('cognitive plugin activated')
      return { state: { initialized: true, chatbotConfig, chatbotRef, chatbotGen: 0 } }
    },
    stopped: (state, ctx) => {
      ctx.log.info('cognitive plugin deactivating')
      return { state }
    },
  }),

  handler: (state, msg, ctx) => {
    if (state.chatbotRef) ctx.stop(state.chatbotRef)
    const newChatbot = msg.slice?.chatbot ?? null
    const chatbotGen = state.chatbotGen + 1
    const chatbotRef = newChatbot
      ? ctx.spawn(`chatbot-${chatbotGen}`, createChatbotActor(newChatbot), { history: {}, pending: {} })
      : null
    return { state: { ...state, chatbotConfig: newChatbot, chatbotRef, chatbotGen } }
  },
}

export default cognitivePlugin
