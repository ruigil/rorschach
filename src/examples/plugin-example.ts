import { AgentSystem, LogTopic, onLifecycle, staticSource } from '../system/index.ts'
import type { ActorDef, ActorContext, ActorRef, LogEvent, PluginDef, PluginSystem } from '../system/index.ts'

// ─── Inline plugin definition ─────────────────────────────────────────────────

type CounterConfig = { startAt: number; tickMs: number }
type CounterPluginMsg = { type: 'config'; options: CounterConfig }
type CounterPluginState = { counterRef: ActorRef<unknown> | null; tickerRef: ActorRef<unknown> | null }

const spawnCounterChildren = (config: CounterConfig, ctx: ActorContext<CounterPluginMsg>) => {
  type CounterMsg = { type: 'increment' } | { type: 'reset' }
  const counterDef: ActorDef<CounterMsg, { count: number }> = {
    initialState: { count: config.startAt },
    handler: (s, msg) =>
      msg.type === 'increment'
        ? { state: { count: s.count + 1 } }
        : { state: { count: 0 } },
    lifecycle: onLifecycle({
      start(s, counterCtx) {
        counterCtx.log.info(`counter started at ${s.count}`)
        return { state: s }
      },
    }),
  }
  const counterRef = ctx.spawn('counter', counterDef) as ActorRef<unknown>

  type TickMsg = { type: 'tick' }
  const tickerDef: ActorDef<TickMsg, null> = {
    initialState: null,
    lifecycle: onLifecycle({
      start(s, tickCtx) {
        tickCtx.timers.startPeriodicTimer('tick', { type: 'tick' }, config.tickMs)
        return { state: s }
      },
    }),
    handler: (s) => {
      counterRef.send({ type: 'increment' } as unknown)
      return { state: s }
    },
  }
  const tickerRef = ctx.spawn('ticker', tickerDef) as ActorRef<unknown>

  return { counterRef, tickerRef }
}

const createCounterPlugin = (config: CounterConfig): PluginDef<CounterPluginMsg, CounterPluginState, CounterConfig> => ({
  id: 'counter',
  version: '1.0.0',
  description: 'Periodically increments a counter and logs its value',
  configDescriptor: {
    defaults: config,
  },
  initialState: { counterRef: null, tickerRef: null },

  handler(state, msg, ctx) {
    if (state.counterRef) ctx.stop(state.counterRef)
    if (state.tickerRef) ctx.stop(state.tickerRef)
    const { counterRef, tickerRef } = spawnCounterChildren(msg.options, ctx)
    ctx.log.info(`counter reconfigured (startAt=${msg.options.startAt}, tickMs=${msg.options.tickMs})`)
    return { state: { counterRef, tickerRef } }
  },

  lifecycle: onLifecycle({
    start(state, ctx) {
      const { counterRef, tickerRef } = spawnCounterChildren(config, ctx)
      ctx.log.info(`counter plugin activated (startAt=${config.startAt}, tickMs=${config.tickMs})`)
      return { state: { ...state, counterRef, tickerRef } }
    },
    stopped(state, ctx) {
      ctx.log.info('counter plugin deactivating')
      return { state }
    },
  }),
})

const pluginIds = (system: PluginSystem) =>
  (system.control().snapshotActual().plugins ?? []).map(
    (p) => `${p.id}@${p.version}`,
  )

const waitFor = async (pred: () => boolean, timeoutMs = 5000) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return
    await Bun.sleep(50)
  }
  throw new Error('waitFor timeout')
}

// ─── Boot via staticSource (first converge) ───────────────────────────────────

const counter = createCounterPlugin({ startAt: 0, tickMs: 1_000 })
const source = staticSource({ plugins: [counter] })
const system = await AgentSystem({ source })

system.subscribe(LogTopic, (e) => {
  const { level, source: src, message } = e as LogEvent
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[${ts}] ${level.toUpperCase().padEnd(5)} [${src}] ${message}`)
})

console.log('\n── Startup plugins loaded ──')
console.log('Active plugins:', pluginIds(system))

// ─── Dynamically load greeter via desired-state write ─────────────────────────

await Bun.sleep(2_000)

console.log('\n── Loading greeter plugin from file (desired write) ──')
const greeterPath = import.meta.dir + '/plugins/greeter.plugin.ts'
const { default: createGreeterPlugin } = await import(greeterPath)
const greeter = createGreeterPlugin({ name: 'Rorschach', intervalMs: 1_500 })

await source.write(() => ({
  plugins: [counter, { def: greeter, modulePath: greeterPath }],
}))
await waitFor(() => pluginIds(system).some((id) => id.startsWith('greeter@')))
console.log('Active plugins:', pluginIds(system))

// ─── Unload counter via desired write ─────────────────────────────────────────

await Bun.sleep(3_000)

console.log('\n── Unloading counter plugin (desired write) ──')
await source.write(() => ({
  plugins: [{ def: greeter, modulePath: greeterPath }],
}))
await waitFor(() => !pluginIds(system).some((id) => id.startsWith('counter@')))
console.log('Active plugins:', pluginIds(system))

// ─── Reload greeter via reloadNonce ───────────────────────────────────────────

await Bun.sleep(2_000)

console.log('\n── Reloading greeter plugin (desired rewrite) ──')
await source.write(() => ({
  plugins: [{ def: createGreeterPlugin({ name: 'Rorschach', intervalMs: 1_500 }), modulePath: greeterPath }],
}))
await waitFor(() => pluginIds(system).some((id) => id.startsWith('greeter@')))
console.log('Reload complete')

// ─── Final state ──────────────────────────────────────────────────────────────

await Bun.sleep(2_000)

console.log('\n── Active plugins at shutdown ──')
console.log(pluginIds(system))

await system.shutdown()
