import type { ActorContext, ActorDef, PluginDef } from '../../system/index.ts'

type GreeterConfig = {
  name: string
  intervalMs: number
}

type GreeterPluginMsg = { type: 'config'; options: GreeterConfig }

const spawnTicker = (config: GreeterConfig, ctx: ActorContext<GreeterPluginMsg>) => {
  type TickMsg = { type: 'tick' }
  const tickerDef: ActorDef<TickMsg, null> = {
    lifecycle: (s, ev, tickCtx) => {
      if (ev.type === 'start')
        tickCtx.timers.startPeriodicTimer('tick', { type: 'tick' }, config.intervalMs)
      return { state: s }
    },
    handler: (s, _msg, tickCtx) => {
      tickCtx.log.info(`Hello from ${config.name}!`)
      return { state: s }
    },
  }
  ctx.spawn('ticker', tickerDef, null)
}

const createGreeterPlugin = (config: GreeterConfig): PluginDef<GreeterPluginMsg, null> => ({
  id: 'greeter',
  version: '1.0.0',
  description: 'Periodically logs a greeting',
  initialState: null,

  handler(state, msg, ctx) {
    const ticker = ctx.lookup('ticker')
    if (ticker) ctx.stop(ticker)
    spawnTicker(msg.options, ctx)
    ctx.log.info(`greeter reconfigured (name="${msg.options.name}", intervalMs=${msg.options.intervalMs})`)
    return { state }
  },

  lifecycle(state, event, ctx) {
    if (event.type === 'start') {
      spawnTicker(config, ctx)
      ctx.log.info(`greeter plugin activated (name="${config.name}", intervalMs=${config.intervalMs})`)
    }
    if (event.type === 'stopped') {
      ctx.log.info('greeter plugin deactivating')
    }
    return { state }
  },
})

export default createGreeterPlugin
