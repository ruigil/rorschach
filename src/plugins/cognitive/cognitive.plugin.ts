import { createChatbotActor, type ChatbotActorOptions } from './chatbot.ts'
import type { PluginDef } from '../../system/types.ts'
import { onLifecycle } from '../../system/match.ts'
import { ConfigTopic, type SystemConfig, type ConfigMsg } from '../config/types.ts'
import { ask } from '../../system/ask.ts'

export type CognitiveConfig = {
  chatbot?: ChatbotActorOptions
}

type PluginMsg = { type: 'config'; slice: CognitiveConfig | undefined }
type PluginState = { initialized: boolean }

const cognitivePlugin: PluginDef<PluginMsg, PluginState> = {
  id: 'cognitive',
  version: '1.0.0',
  description: 'Cognitive actors: LLM-backed chatbot',
  dependencies: ['config'],
  initialState: { initialized: false },

  lifecycle: onLifecycle({
    start: async (_state, ctx) => {
      ctx.subscribe(ConfigTopic, (cfg) => ({ type: 'config' as const, slice: cfg.cognitive }))

      const storeRef = ctx.lookup<ConfigMsg>('system/$plugin-config/store')!
      const current = await ask<ConfigMsg, SystemConfig>(storeRef, (replyTo) => ({ type: 'get', replyTo }))

      if (current.cognitive?.chatbot) {
        ctx.spawn('chatbot', createChatbotActor(current.cognitive.chatbot), { history: {}, pending: {} })
      }

      ctx.log.info('cognitive plugin activated')
      return { state: { initialized: true } }
    },
    stopped: (state, ctx) => {
      ctx.log.info('cognitive plugin deactivating')
      return { state }
    },
  }),

  handler: (state, msg, ctx) => {
    const chatbot = ctx.lookup('chatbot')
    if (chatbot) ctx.stop(chatbot)

    if (msg.slice?.chatbot) {
      ctx.spawn('chatbot', createChatbotActor(msg.slice.chatbot), { history: {}, pending: {} })
    }

    return { state }
  },
}

export default cognitivePlugin
