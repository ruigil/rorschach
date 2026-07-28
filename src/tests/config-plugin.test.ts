import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { AgentSystem, type PluginSystem } from '../system/index.ts'
import ConfigPlugin from '../plugins/config/config.plugin.ts'
import type { RouteRegistration } from '../types/routes.ts'
import { RouteRegistrationTopic } from '../types/routes.ts'

describe('Unified Config Plugin (src/plugins/config)', () => {
  let system: PluginSystem

  beforeEach(async () => {
    system = await AgentSystem({
      plugins: [ConfigPlugin],
    })
  })

  afterEach(async () => {
    if (system) {
      await system.shutdown()
    }
  })

  test('registers config plugin cleanly into system', () => {
    const plugins = system.listPlugins()
    const configPlugin = plugins.find((p) => p.id === 'config')
    expect(configPlugin).toBeDefined()
    expect(configPlugin?.status).toBe('active')
  })

  test('publishes config REST route registrations', async () => {
    const routes: RouteRegistration[] = []
    const unsubscribe = system.subscribe(RouteRegistrationTopic, (event) => {
      routes.push(event)
    })

    await new Promise((r) => setTimeout(r, 50))

    unsubscribe()
    expect(routes.length).toBeGreaterThan(0)
    const paths = routes.map((r) => r.path)
    expect(paths).toContain('/config')
    expect(paths).toContain('/config/schema')
    expect(paths).toContain('/config/plugins')
  })
})
