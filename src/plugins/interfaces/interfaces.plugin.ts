import { HTTP, type HTTPOptions } from './http.ts'
import { CLI } from './cli.ts'
import { Signal, type SignalOptions } from './signal.ts'
import { defineConfig, createSlot, stopSlot, publishConfigSurface, deleteConfigSurface, type ActorSlot } from '../../system/index.ts'
import type { PluginDef } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { interfacesSchemas } from './routes.ts'

export type InterfacesConfig = {
  http?:   HTTPOptions
  cli?:    Record<string, never>
  signal?: SignalOptions
}

const config = defineConfig<InterfacesConfig>('interfaces', {}, {
  schemas: interfacesSchemas,
})

type PluginMsg = { type: 'config'; slice: InterfacesConfig | undefined }
type PluginState = {
  initialized: boolean
  http:   ActorSlot<HTTPOptions>
  cli:    ActorSlot<Record<string, never>>
  signal: ActorSlot<SignalOptions>
}

const interfacesPlugin: PluginDef<PluginMsg, PluginState, InterfacesConfig> = {
  id: 'interfaces',
  version: '1.0.0',
  description: 'External interfaces: HTTP server and WebSocket',

  configDescriptor: config,

  initialState: {
    initialized: false,
    http:   createSlot(),
    cli:    createSlot(),
    signal: createSlot(),
  },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.initialConfig() as InterfacesConfig | undefined

      publishConfigSurface(ctx, config, () => slice)

      const httpRef = slice?.http
        ? ctx.spawn('http-0', HTTP(slice.http))
        : null
      const cliRef = slice?.cli
        ? ctx.spawn('cli-0', CLI())
        : null
      const signalRef = slice?.signal
        ? ctx.spawn('signal-0', Signal(slice.signal))
        : null

      ctx.log.info('interfaces plugin activated')
      return { state: {
        initialized: true,
        http:   { config: slice?.http   ?? null, ref: httpRef,   gen: 0 },
        cli:    { config: slice?.cli    ?? null, ref: cliRef,    gen: 0 },
        signal: { config: slice?.signal ?? null, ref: signalRef, gen: 0 },
      } }
    },
    stopped: (state, ctx) => {
      stopSlot(ctx, state.http)
      stopSlot(ctx, state.cli)
      stopSlot(ctx, state.signal)

      deleteConfigSurface(ctx, config)

      ctx.log.info('interfaces plugin deactivating')
      return { state }
    },
  }),

  handler: onMessage<PluginMsg, PluginState>({
    config: (state, msg, ctx) => {
      stopSlot(ctx, state.http)
      stopSlot(ctx, state.cli)
      stopSlot(ctx, state.signal)

      const newHttpConfig = msg.slice?.http ?? null
      const newCliConfig = msg.slice?.cli ?? null
      const newSignalConfig = msg.slice?.signal ?? null

      const httpRef = newHttpConfig
        ? ctx.spawn(`http-${state.http.gen + 1}`, HTTP(newHttpConfig))
        : null
      const cliRef = newCliConfig
        ? ctx.spawn(`cli-${state.cli.gen + 1}`, CLI())
        : null
      const signalRef = newSignalConfig
        ? ctx.spawn(`signal-${state.signal.gen + 1}`, Signal(newSignalConfig))
        : null

      return { state: {
        ...state,
        http:   { config: newHttpConfig,   ref: httpRef,   gen: state.http.gen + 1   },
        cli:    { config: newCliConfig,    ref: cliRef,    gen: state.cli.gen + 1    },
        signal: { config: newSignalConfig, ref: signalRef, gen: state.signal.gen + 1 },
      } }
    },
  }),
}

export default interfacesPlugin
