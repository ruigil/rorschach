import type { ActorDef } from '../../system/types.ts'
import { ConfigTopic, ConfigCommandTopic } from './types.ts'
import type { ConfigMsg, SystemConfig } from './types.ts'

export function createConfigActor(initial: SystemConfig): ActorDef<ConfigMsg, SystemConfig> {
  return {
    supervision: { type: 'restart', maxRetries: 5, withinMs: 60_000 },

    lifecycle: async (state, event, ctx) => {
      if (event.type === 'start') {
        // Accept commands sent via the event bus (for callers without a direct ref)
        ctx.subscribe(ConfigCommandTopic, (msg) => msg)
        // Emit the initial snapshot so already-subscribed watchers receive it
        ctx.publish(ConfigTopic, state)
      }
      return { state }
    },

    handler(state, msg, ctx) {
      switch (msg.type) {
        case 'set': {
          const next = { ...state, [msg.key]: msg.value }
          ctx.publish(ConfigTopic, next)
          return { state: next }
        }
        case 'update': {
          const slice = (state[msg.key] ?? {}) as object
          const next = { ...state, [msg.key]: { ...slice, ...msg.patch } }
          ctx.publish(ConfigTopic, next)
          return { state: next }
        }
        case 'replace': {
          ctx.publish(ConfigTopic, msg.config)
          return { state: msg.config }
        }
        case 'get': {
          msg.replyTo.send(state)
          return { state }
        }
      }
    },
  }
}
