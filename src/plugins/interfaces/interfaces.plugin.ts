import { createHttpActor, type HttpActorOptions, type HttpState } from './http.ts'
import type { ActorIdentity, PluginDef } from '../../system/types.ts'
import { onLifecycle } from '../../system/match.ts'

export type InterfacesConfig = {
  http?: HttpActorOptions
}

type PluginMsg = { type: 'config'; slice: InterfacesConfig | undefined }
type PluginState = { initialized: boolean; httpConfig: HttpActorOptions | null; httpRef: ActorIdentity | null; httpGen: number }

const interfacesPlugin: PluginDef<PluginMsg, PluginState, InterfacesConfig> = {
  id: 'interfaces',
  version: '1.0.0',
  description: 'External interfaces: HTTP server and WebSocket',

  configDescriptor: {
    defaults: {},
    onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
  },

  initialState: { initialized: false, httpConfig: null, httpRef: null, httpGen: 0 },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.config as InterfacesConfig | undefined

      const httpConfig = slice?.http ?? null
      const httpRef = httpConfig
        ? ctx.spawn('http-0', createHttpActor(httpConfig), { server: null, connections: 0 } as HttpState)
        : null

      ctx.log.info('interfaces plugin activated')
      return { state: { initialized: true, httpConfig, httpRef, httpGen: 0 } }
    },
    stopped: (state, ctx) => {
      ctx.log.info('interfaces plugin deactivating')
      return { state }
    },
  }),

  handler: (state, msg, ctx) => {
    const newHttp = msg.slice?.http ?? null
    if (newHttp && JSON.stringify(newHttp) !== JSON.stringify(state.httpConfig)) {
      if (state.httpRef) ctx.stop(state.httpRef)
      const httpGen = state.httpGen + 1
      const httpRef = ctx.spawn(`http-${httpGen}`, createHttpActor(newHttp), { server: null, connections: 0 } as HttpState)
      return { state: { ...state, httpConfig: newHttp, httpRef, httpGen } }
    }

    return { state }
  },
}

export default interfacesPlugin
