import type { PluginDef } from '../../system/types.ts'
import { onLifecycle } from '../../system/match.ts'
import { createConfigActor } from './config-actor.ts'
import type { SystemConfig } from './types.ts'

export { ConfigTopic, ConfigCommandTopic } from './types.ts'
export type { SystemConfig, ConfigMsg } from './types.ts'

type ConfigPluginMsg = { type: 'reload'; config: SystemConfig }

export const createConfigPlugin = (config: SystemConfig): PluginDef<ConfigPluginMsg, null> => ({
  id: 'config',
  version: '1.0.0',
  description: 'Unified configuration store — single source of truth for all plugin configs',
  initialState: null,

  handler: (state, msg, ctx) => {
    const store = ctx.lookup('store')
    if (store) ctx.stop(store)
    ctx.spawn('store', createConfigActor(msg.config), msg.config)
    return { state }
  },

  lifecycle: onLifecycle({
    start: (state, ctx) => {
      ctx.spawn('store', createConfigActor(config), config)
      return { state }
    },
  }),
})
