import { describe, test, expect } from 'bun:test'
import {
  AgentSystem,
  defineConfig,
  buildConfigRoute,
  publishConfigSurface,
  deleteConfigSurface,
} from '../system/index.ts'
import type { ActorDef } from '../system/index.ts'
import { ConfigSchemaTopic, type ConfigSchemaSection } from '../types/config.ts'
import { RouteRegistrationTopic, type RouteRegistration } from '../types/routes.ts'

const tick = (ms = 50) => Bun.sleep(ms)

describe('plugin config surface helpers', () => {
  test('buildConfigRoute derives the standard route id and path', async () => {
    const descriptor = defineConfig('sample', { enabled: true })
    const [route] = buildConfigRoute(descriptor, () => ({ enabled: false }))

    expect(route?.id).toBe('config.sample')
    expect(route?.method).toBe('GET')
    expect(route?.path).toBe('/config/sample')

    expect(route?.handler).not.toBeNull()
    if (!route || route.handler === null) throw new Error('expected config route handler')
    const response = await route.handler(new Request('http://localhost/config/sample'), new URL('http://localhost/config/sample'))
    expect(response.headers.get('Content-Type')).toBe('application/json')
    expect(await response.json()).toEqual({ enabled: false })
  })

  test('publishConfigSurface and deleteConfigSurface publish retained schemas and route tombstones', async () => {
    const schema: ConfigSchemaSection = {
      id: 'sample.config',
      title: 'Sample',
      tab: 'sample',
      configKey: '',
      routeId: 'config.sample',
      schema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', default: true },
        },
      },
    }
    const descriptor = defineConfig('sample', { enabled: true }, { schemas: [schema] })

    type Msg = { type: 'noop' }
    const def: ActorDef<Msg, null> = {
      initialState: null,
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') {
          publishConfigSurface(ctx, descriptor, () => ({ enabled: true }))
        }
        if (event.type === 'stopped') {
          deleteConfigSurface(ctx, descriptor)
        }
        return { state }
      },
      handler: (state) => ({ state }),
    }

    const system = await AgentSystem()
    const ref = system.spawn('config-surface', def)
    await tick()

    const schemas: ConfigSchemaSection[] = []
    const routes: RouteRegistration[] = []
    system.subscribe(ConfigSchemaTopic, (event) => schemas.push(event))
    system.subscribe(RouteRegistrationTopic, (event) => routes.push(event))
    await tick()

    expect(schemas.at(-1)).toEqual(schema)
    expect(routes.at(-1)).toMatchObject({ id: 'config.sample', method: 'GET', path: '/config/sample' })
    expect(routes.at(-1)!.handler).not.toBeNull()

    system.stop(ref)
    await tick()

    expect(schemas.at(-1)).toEqual({ ...schema, schema: null })
    expect(routes.at(-1)).toMatchObject({ id: 'config.sample', method: 'GET', path: '/config/sample', handler: null })

    await system.shutdown()
  })
})
