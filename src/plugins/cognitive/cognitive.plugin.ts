import { createChatbotActor, type ChatbotActorOptions } from './chatbot.ts'
import type { ActorIdentity, PluginDef } from '../../system/types.ts'
import { onLifecycle } from '../../system/match.ts'
import { ConfigTopic, type SystemConfig, type ConfigMsg } from '../config/types.ts'
import { ask } from '../../system/ask.ts'

export type CognitiveConfig = {
  chatbot?: ChatbotActorOptions
}

type PluginMsg = { type: 'config'; slice: CognitiveConfig | undefined }
type PluginState = { initialized: boolean; chatbotConfig: ChatbotActorOptions | null; chatbotRef: ActorIdentity | null; chatbotGen: number }

const cognitivePlugin: PluginDef<PluginMsg, PluginState> = {
  id: 'cognitive',
  version: '1.0.0',
  description: 'Cognitive actors: LLM-backed chatbot',
  dependencies: ['config'],
  initialState: { initialized: false, chatbotConfig: null, chatbotRef: null, chatbotGen: 0 },

  lifecycle: onLifecycle({
    start: async (_state, ctx) => {
      ctx.subscribe(ConfigTopic, (cfg) => ({ type: 'config' as const, slice: cfg.cognitive }))

      const storeRef = ctx.lookup<ConfigMsg>('system/config/store')!
      const current = await ask<ConfigMsg, SystemConfig>(storeRef, (replyTo) => ({ type: 'get', replyTo }))

      const chatbotConfig = current.cognitive?.chatbot ?? null
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
    const newChatbot = msg.slice?.chatbot ?? null
    if (newChatbot && JSON.stringify(newChatbot) !== JSON.stringify(state.chatbotConfig)) {
      if (state.chatbotRef) ctx.stop(state.chatbotRef)
      const chatbotGen = state.chatbotGen + 1
      const chatbotRef = ctx.spawn(`chatbot-${chatbotGen}`, createChatbotActor(newChatbot), { history: {}, pending: {} })
      return { state: { ...state, chatbotConfig: newChatbot, chatbotRef, chatbotGen } }
    }

    return { state }
  },
}

export default cognitivePlugin
