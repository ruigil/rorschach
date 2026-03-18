import { createPluginSystem, LogTopic, onLifecycle } from '../system/index.ts'
import type { ActorDef, ActorContext, LogEvent, PluginDef } from '../system/index.ts'


// ─── Inline plugin definition ─────────────────────────────────────────────────

type CounterConfig = { startAt: number; tickMs: number }
type CounterPluginMsg = { type: 'config'; options: CounterConfig }

const spawnCounterChildren = (config: CounterConfig, ctx: ActorContext<CounterPluginMsg>) => {
  type CounterMsg = { type: 'increment' } | { type: 'reset' }
  const counterDef: ActorDef<CounterMsg, { count: number }> = {
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
  const counter = ctx.spawn('counter', counterDef, { count: config.startAt })

  type TickMsg = { type: 'tick' }
  const tickerDef: ActorDef<TickMsg, null> = {
    lifecycle: onLifecycle({
      start(s, tickCtx) {
        tickCtx.timers.startPeriodicTimer('tick', { type: 'tick' }, config.tickMs)
        return { state: s }
      },
    }),
    handler: (s) => {
      counter.send({ type: 'increment' })
      return { state: s }
    },
  }
  ctx.spawn('ticker', tickerDef, null)
}

const createCounterPlugin = (config: CounterConfig): PluginDef<CounterPluginMsg, null> => ({
  id: 'counter',
  version: '1.0.0',
  description: 'Periodically increments a counter and logs its value',
  initialState: null,

  handler(state, msg, ctx) {
    const counter = ctx.lookup('counter')
    const ticker = ctx.lookup('ticker')
    if (counter) ctx.stop(counter)
    if (ticker) ctx.stop(ticker)
    spawnCounterChildren(msg.options, ctx)
    ctx.log.info(`counter reconfigured (startAt=${msg.options.startAt}, tickMs=${msg.options.tickMs})`)
    return { state }
  },

  lifecycle: onLifecycle({
    start(state, ctx) {
      spawnCounterChildren(config, ctx)
      ctx.log.info(`counter plugin activated (startAt=${config.startAt}, tickMs=${config.tickMs})`)
      return { state }
    },
    stopped(state, ctx) {
      ctx.log.info('counter plugin deactivating')
      return { state }
    },
  }),
})

// ─── Create system with counter loaded at startup ─────────────────────────────

const system = await createPluginSystem({
  plugins: [createCounterPlugin({ startAt: 0, tickMs: 1_000 })],
})

// Print all log events to the console
system.subscribe('console-logger', LogTopic, (e) => {
  const { level, source, message } = e as LogEvent
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[${ts}] ${level.toUpperCase().padEnd(5)} [${source}] ${message}`)
})

console.log('\n── Startup plugins loaded ──')
console.log('Active plugins:', system.listPlugins().map(p => `${p.id}@${p.version}`))

// ─── Dynamically load a plugin from a file at runtime ────────────────────────

await Bun.sleep(2_000)

console.log('\n── Loading greeter plugin from file ──')
const greeterPath = import.meta.dir + '/plugins/greeter.plugin.ts'
const { default: createGreeterPlugin } = await import(greeterPath)
const result = await system.use(createGreeterPlugin({ name: 'Rorschach', intervalMs: 1_500 }))
console.log('Load result:', result)
console.log('Active plugins:', system.listPlugins().map(p => `${p.id}@${p.version}`))

// ─── Unload the inline plugin ─────────────────────────────────────────────────

await Bun.sleep(3_000)

console.log('\n── Unloading counter plugin ──')
const unloadResult = await system.unloadPlugin('counter')
console.log('Unload result:', unloadResult)

// ─── Reload the greeter plugin (same def, restarts the actor subtree) ─────────

await Bun.sleep(2_000)

console.log('\n── Reloading greeter plugin ──')
const reloadResult = await system.reloadPlugin('greeter')
console.log('Reload result:', reloadResult)

// ─── Hot reload from disk (re-imports the module, picks up code changes) ──────

await Bun.sleep(2_000)

console.log('\n── Hot reloading greeter plugin from disk ──')
const hotResult = await system.hotReloadPlugin('greeter', greeterPath)
console.log('Hot reload result:', hotResult)

// ─── Final state ──────────────────────────────────────────────────────────────

await Bun.sleep(2_000)

console.log('\n── Active plugins at shutdown ──')
console.log(system.listPlugins().map(p => `${p.id}@${p.version} [${p.status}]`))

await system.shutdown()
