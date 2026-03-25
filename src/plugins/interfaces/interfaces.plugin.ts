import { createHttpActor, type HttpActorOptions, type HttpState } from './http.ts'
import { createCliActor, CLI_INITIAL_STATE } from './cli.ts'
import type { ActorIdentity, PluginDef } from '../../system/types.ts'
import { onLifecycle } from '../../system/match.ts'

export type InterfacesConfig = {
  http?: HttpActorOptions
  cli?: Record<string, never>
}

type PluginMsg = { type: 'config'; slice: InterfacesConfig | undefined }
type PluginState = {
  initialized: boolean
  httpConfig:  HttpActorOptions | null
  httpRef:     ActorIdentity | null
  httpGen:     number
  cliRef:      ActorIdentity | null
  cliGen:      number
}

const interfacesPlugin: PluginDef<PluginMsg, PluginState, InterfacesConfig> = {
  id: 'interfaces',
  version: '1.0.0',
  description: 'External interfaces: HTTP server and WebSocket',
  precedes: ['cognitive'],

  configDescriptor: {
    defaults: {},
    onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
  },

  initialState: { initialized: false, httpConfig: null, httpRef: null, httpGen: 0, cliRef: null, cliGen: 0 },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.config as InterfacesConfig | undefined

      const httpConfig = slice?.http ?? null
      const httpRef = httpConfig
        ? ctx.spawn('http-0', createHttpActor(httpConfig), { server: null, connections: 0, activeSpans: {}, llmProviderRef: null } as HttpState)
        : null

      const cliRef = slice?.cli !== undefined
        ? ctx.spawn('cli-0', createCliActor(), { ...CLI_INITIAL_STATE })
        : null

      ctx.log.info('interfaces plugin activated')
      return { state: { initialized: true, httpConfig, httpRef, httpGen: 0, cliRef, cliGen: 0 } }
    },
    stopped: (state, ctx) => {
      ctx.log.info('interfaces plugin deactivating')
      return { state }
    },
  }),

  handler: (state, msg, ctx) => {
    if (state.httpRef) ctx.stop(state.httpRef)
    if (state.cliRef)  ctx.stop(state.cliRef)

    const newHttp = msg.slice?.http ?? null
    const httpGen = state.httpGen + 1
    const httpRef = newHttp
      ? ctx.spawn(`http-${httpGen}`, createHttpActor(newHttp), { server: null, connections: 0, activeSpans: {}, llmProviderRef: null } as HttpState)
      : null

    const cliGen = state.cliGen + 1
    const cliRef = msg.slice?.cli !== undefined
      ? ctx.spawn(`cli-${cliGen}`, createCliActor(), { ...CLI_INITIAL_STATE })
      : null

    return { state: { ...state, httpConfig: newHttp, httpRef, httpGen, cliRef, cliGen } }
  },
}

export default interfacesPlugin
