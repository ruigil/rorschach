import { createHttpActor, type HttpActorOptions, type HttpState } from './http.ts'
import type { PluginDef } from '../../system/types.ts'
import { ConfigTopic, type SystemConfig, type ConfigMsg } from '../config/types.ts'
import { ask } from '../../system/ask.ts'

export type InterfacesConfig = {
  http?: HttpActorOptions
}

type PluginMsg = { type: 'config'; slice: InterfacesConfig | undefined }
type PluginState = { initialized: boolean }

const interfacesPlugin: PluginDef<PluginMsg, PluginState> = {
  id: 'interfaces',
  version: '1.0.0',
  description: 'External interfaces: HTTP server and WebSocket',
  dependencies: ['config'],
  initialState: { initialized: false },

  lifecycle: async (state, event, ctx) => {
    if (event.type === 'start') {
      ctx.subscribe(ConfigTopic, (cfg) => ({ type: 'config' as const, slice: cfg.interfaces }))

      const storeRef = ctx.lookup<ConfigMsg>('system/$plugin-config/store')!
      const current = await ask<ConfigMsg, SystemConfig>(storeRef, (replyTo) => ({ type: 'get', replyTo }))

      if (current.interfaces?.http) {
        const initialState: HttpState = { server: null, connections: 0 }
        ctx.spawn('http', createHttpActor(current.interfaces.http), initialState)
      }

      ctx.log.info('interfaces plugin activated')
      return { state: { initialized: true } }
    }
    if (event.type === 'stopped') {
      ctx.log.info('interfaces plugin deactivating')
    }
    return { state }
  },

  handler(state, msg, ctx) {
    const http = ctx.lookup('http')
    if (http) ctx.stop(http)

    if (msg.slice?.http) {
      const initialState: HttpState = { server: null, connections: 0 }
      ctx.spawn('http', createHttpActor(msg.slice.http), initialState)
    }

    return { state }
  },
}

export default interfacesPlugin
