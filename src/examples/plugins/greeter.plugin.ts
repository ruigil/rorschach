import type { ActorContext, ActorDef, ActorRef, PluginDef } from '../../system/index.ts'
import { onLifecycle } from '../../system/index.ts'

type GreeterConfig = {
  name: string
  intervalMs: number
}

type GreeterPluginMsg = { type: 'config'; options: GreeterConfig }
type GreeterPluginState = { tickerRef: ActorRef<unknown> | null }

const spawnTicker = (config: GreeterConfig, ctx: ActorContext<GreeterPluginMsg>): ActorRef<unknown> => {
  type TickMsg = { type: 'tick' }
  const tickerDef: ActorDef<TickMsg, null> = {
    lifecycle: onLifecycle({
      start(s, tickCtx) {
        tickCtx.timers.startPeriodicTimer('tick', { type: 'tick' }, config.intervalMs)
        return { state: s }
      },
    }),
    handler: (s, _msg, tickCtx) => {
      tickCtx.log.info(`Hello from ${config.name}!`)
      return { state: s }
    },
  }
  return ctx.spawn('ticker', tickerDef, null) as ActorRef<unknown>
}

const createGreeterPlugin = (config: GreeterConfig): PluginDef<GreeterPluginMsg, GreeterPluginState> => ({
  id: 'greeter',
  version: '1.0.0',
  description: 'Periodically logs a greeting',
  initialState: { tickerRef: null },

  handler(state, msg, ctx) {
    if (state.tickerRef) ctx.stop(state.tickerRef)
    const tickerRef = spawnTicker(msg.options, ctx)
    ctx.log.info(`greeter reconfigured (name="${msg.options.name}", intervalMs=${msg.options.intervalMs})`)
    return { state: { tickerRef } }
  },

  lifecycle: onLifecycle({
    start(state, ctx) {
      const tickerRef = spawnTicker(config, ctx)
      ctx.log.info(`greeter plugin activated (name="${config.name}", intervalMs=${config.intervalMs})`)
      return { state: { ...state, tickerRef } }
    },
    stopped(state, ctx) {
      ctx.log.info('greeter plugin deactivating')
      return { state }
    },
  }),
})

export default createGreeterPlugin
