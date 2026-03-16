import type { ActorContext, ActorDef } from '../../system/index.ts'
import type { PluginDef, PluginHandle } from '../../plugins/types.ts'

type GreeterConfig = {
  name: string
  intervalMs: number
}

type GreeterMsg = { type: 'greet' }

const greeterActorDef: ActorDef<GreeterMsg, { name: string }> = {
  lifecycle: (state, event, ctx) => {
    if (event.type === 'start')
      ctx.timers.startPeriodicTimer('greet', { type: 'greet' }, ctx.messageHeaders()['intervalMs'] ? Number(ctx.messageHeaders()['intervalMs']) : 1000)
    return { state }
  },
  handler: (state, _msg, ctx) => {
    ctx.log.info(`Hello from ${state.name}!`)
    return { state }
  },
}

const greeterPlugin: PluginDef<GreeterConfig> = {
  id: 'greeter',
  version: '1.0.0',
  description: 'Periodically logs a greeting',

  activate(ctx: ActorContext<never>, config: GreeterConfig): PluginHandle {
    type TickMsg = { type: 'tick' }
    const tickerDef: ActorDef<TickMsg, null> = {
      lifecycle: (state, event, tickCtx) => {
        if (event.type === 'start')
          tickCtx.timers.startPeriodicTimer('tick', { type: 'tick' }, config.intervalMs)
        return { state }
      },
      handler: (state, _msg, tickCtx) => {
        tickCtx.log.info(`Hello from ${config.name}!`)
        return { state }
      },
    }

    ctx.spawn('ticker', tickerDef, null)
    ctx.log.info(`greeter plugin activated (name="${config.name}", intervalMs=${config.intervalMs})`)

    return {
      deactivate() {
        ctx.log.info('greeter plugin deactivating')
      },
    }
  },
}

export default greeterPlugin
