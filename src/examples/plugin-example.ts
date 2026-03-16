import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPluginSystem, LogTopic } from '../system/index.ts'
import type { ActorDef, LogEvent } from '../system/index.ts'
import type { PluginDef, PluginHandle } from '../plugins/types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Inline plugin definition ─────────────────────────────────────────────────

type CounterPluginConfig = { startAt: number; tickMs: number }

const counterPlugin: PluginDef<CounterPluginConfig> = {
  id: 'counter',
  version: '1.0.0',
  description: 'Periodically increments a counter and logs its value',

  activate(ctx, config: CounterPluginConfig): PluginHandle {
    type CounterMsg = { type: 'increment' } | { type: 'reset' }
    const counterDef: ActorDef<CounterMsg, { count: number }> = {
      handler: (state, msg) =>
        msg.type === 'increment'
          ? { state: { count: state.count + 1 } }
          : { state: { count: 0 } },
      lifecycle: (state, event, counterCtx) => {
        if (event.type === 'start') counterCtx.log.info(`counter started at ${state.count}`)
        return { state }
      },
    }
    const counter = ctx.spawn('counter', counterDef, { count: config.startAt })

    type TickMsg = { type: 'tick' }
    const tickerDef: ActorDef<TickMsg, null> = {
      lifecycle: (state, event, tickCtx) => {
        if (event.type === 'start')
          tickCtx.timers.startPeriodicTimer('tick', { type: 'tick' }, config.tickMs)
        return { state }
      },
      handler: (state, _msg) => {
        counter.send({ type: 'increment' })
        return { state }
      },
    }
    ctx.spawn('ticker', tickerDef, null)

    ctx.log.info(`counter plugin activated (startAt=${config.startAt}, tickMs=${config.tickMs})`)
    return { deactivate() { ctx.log.info('counter plugin deactivating') } }
  },
}

// ─── Create system with counter loaded at startup ─────────────────────────────

const system = await createPluginSystem({
  plugins: [
    { source: { type: 'inline', def: counterPlugin }, config: { startAt: 0, tickMs: 1_000 } },
  ],
})

// Print all log events to the console
system.subscribe('console-logger', LogTopic, (e) => {
  const { level, source, message } = e as LogEvent
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[${ts}] ${level.toUpperCase().padEnd(5)} [${source}] ${message}`)
})

console.log('\n── Startup plugins loaded ──')
console.log('Active plugins:', (await system.listPlugins()).map(p => `${p.id}@${p.version}`))

// ─── Dynamically load a plugin from a file at runtime ────────────────────────

await Bun.sleep(2_000)

console.log('\n── Loading greeter plugin from file ──')
const result = await system.loadPlugin(
  { type: 'path', value: join(__dirname, 'plugins/greeter.plugin.ts') },
  { name: 'Rorschach', intervalMs: 1_500 },
)
console.log('Load result:', result)
console.log('Active plugins:', (await system.listPlugins()).map(p => `${p.id}@${p.version}`))

// ─── Unload the inline plugin ─────────────────────────────────────────────────

await Bun.sleep(3_000)

console.log('\n── Unloading counter plugin ──')
const unloadResult = await system.unloadPlugin('counter')
console.log('Unload result:', unloadResult)

// ─── Reload the dynamically loaded plugin ─────────────────────────────────────

await Bun.sleep(2_000)

console.log('\n── Reloading greeter plugin ──')
const reloadResult = await system.reloadPlugin('greeter')
console.log('Reload result:', reloadResult)

// ─── Final state ──────────────────────────────────────────────────────────────

await Bun.sleep(2_000)

console.log('\n── Active plugins at shutdown ──')
console.log((await system.listPlugins()).map(p => `${p.id}@${p.version} [${p.status}]`))

await system.shutdown()
