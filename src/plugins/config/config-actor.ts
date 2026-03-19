import type { ActorDef } from '../../system/types.ts'
import { redact } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { ConfigTopic, ConfigCommandTopic } from './types.ts'
import type { ConfigMsg, SystemConfig } from './types.ts'

export function createConfigActor(initial: SystemConfig): ActorDef<ConfigMsg, SystemConfig> {
  return {
    supervision: { type: 'restart', maxRetries: 5, withinMs: 60_000 },

    maskState: (state) => ({
      ...state,
      cognitive: state.cognitive && {
        ...state.cognitive,
        chatbot: state.cognitive.chatbot && {
          ...state.cognitive.chatbot,
          apiKey: redact(),
        },
      },
    }),

    lifecycle: onLifecycle({
      start: (state, ctx) => {
        // Accept commands sent via the event bus (for callers without a direct ref)
        ctx.subscribe(ConfigCommandTopic, (msg) => msg)
        // Emit the initial snapshot so already-subscribed watchers receive it
        ctx.publish(ConfigTopic, state)
        return { state }
      },
    }),

    handler: onMessage({
      set: (state, msg, ctx) => {
        const next = { ...state, [msg.key]: msg.value }
        ctx.publish(ConfigTopic, next)
        return { state: next }
      },
      update: (state, msg, ctx) => {
        const slice = (state[msg.key] ?? {}) as object
        const next = { ...state, [msg.key]: { ...slice, ...msg.patch } }
        ctx.publish(ConfigTopic, next)
        return { state: next }
      },
      replace: (_state, msg, ctx) => {
        ctx.publish(ConfigTopic, msg.config)
        return { state: msg.config }
      },
      get: (state, msg) => {
        msg.replyTo.send(state)
        return { state }
      },
    }),
  }
}
