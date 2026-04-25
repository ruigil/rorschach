import { createHttpActor, type HttpActorOptions, type HttpState } from './http.ts'
import { createCliActor, CLI_INITIAL_STATE } from './cli.ts'
import { createSignalActor, type SignalActorOptions } from './signal.ts'
import type { PluginActorState, PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'

export type InterfacesConfig = {
  http?:   HttpActorOptions
  cli?:    Record<string, never>
  signal?: SignalActorOptions
}

type PluginMsg = { type: 'config'; slice: InterfacesConfig | undefined }
type PluginState = {
  initialized: boolean
  http:   PluginActorState<HttpActorOptions>
  cli:    PluginActorState<Record<string, never>>
  signal: PluginActorState<SignalActorOptions>
}

const interfacesPlugin: PluginDef<PluginMsg, PluginState, InterfacesConfig> = {
  id: 'interfaces',
  version: '1.0.0',
  description: 'External interfaces: HTTP server and WebSocket',
  configDescriptor: {
    defaults: {},
    onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
  },

  initialState: {
    initialized: false,
    http:   { config: null, ref: null, gen: 0 },
    cli:    { config: null, ref: null, gen: 0 },
    signal: { config: null, ref: null, gen: 0 },
  },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.initialConfig() as InterfacesConfig | undefined

      const httpConfig   = slice?.http   ?? null
      const cliConfig    = slice?.cli    ?? null
      const signalConfig = slice?.signal ?? null

      const httpRef = httpConfig
        ? ctx.spawn('http-0', createHttpActor(httpConfig), { server: null, connections: 0, activeSpans: {}, llmProviderRef: null, identityProviderRef: null } as HttpState)
        : null
      const cliRef = cliConfig
        ? ctx.spawn('cli-0', createCliActor(), { ...CLI_INITIAL_STATE })
        : null
      const signalRef = signalConfig
        ? ctx.spawn('signal-0', createSignalActor(signalConfig), { seenIds: new Set<string>(), pending: new Map<string, string>(), activeSpans: {}, identityProviderRef: null, pendingConnect: new Map() })
        : null

      ctx.log.info('interfaces plugin activated')
      return { state: {
        initialized: true,
        http:   { config: httpConfig,   ref: httpRef,   gen: 0 },
        cli:    { config: cliConfig,    ref: cliRef,    gen: 0 },
        signal: { config: signalConfig, ref: signalRef, gen: 0 },
      } }
    },
    stopped: (state, ctx) => {
      ctx.log.info('interfaces plugin deactivating')
      return { state }
    },
  }),

  handler: onMessage<PluginMsg, PluginState>({
    config: (state, msg, ctx) => {
      if (state.http.ref)   ctx.stop(state.http.ref)
      if (state.cli.ref)    ctx.stop(state.cli.ref)
      if (state.signal.ref) ctx.stop(state.signal.ref)

      const newHttpConfig   = msg.slice?.http   ?? null
      const newCliConfig    = msg.slice?.cli    ?? null
      const newSignalConfig = msg.slice?.signal ?? null
      const httpGen   = state.http.gen   + 1
      const cliGen    = state.cli.gen    + 1
      const signalGen = state.signal.gen + 1

      const httpRef = newHttpConfig
        ? ctx.spawn(`http-${httpGen}`, createHttpActor(newHttpConfig), { server: null, connections: 0, activeSpans: {}, llmProviderRef: null, identityProviderRef: null } as HttpState)
        : null
      const cliRef = newCliConfig
        ? ctx.spawn(`cli-${cliGen}`, createCliActor(), { ...CLI_INITIAL_STATE })
        : null
      const signalRef = newSignalConfig
        ? ctx.spawn(`signal-${signalGen}`, createSignalActor(newSignalConfig), { seenIds: new Set<string>(), pending: new Map<string, string>(), activeSpans: {}, identityProviderRef: null, pendingConnect: new Map() })
        : null

      return { state: {
        ...state,
        http:   { config: newHttpConfig,   ref: httpRef,   gen: httpGen   },
        cli:    { config: newCliConfig,    ref: cliRef,    gen: cliGen    },
        signal: { config: newSignalConfig, ref: signalRef, gen: signalGen },
      } }
    },
  }),
}

export default interfacesPlugin
