import { describe, test, expect } from 'bun:test'
import {
  AgentSystem,
  defineConfig,
  publishConfigSurface,
  deleteConfigSurface,
  deepMerge,
} from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { type ConfigSchemaSection, ConfigSchemaTopic } from '../types/config.ts'

const tick = (ms = 50) => Bun.sleep(ms)

describe('plugin config surface helpers', () => {
  test('publishConfigSurface and deleteConfigSurface publish retained schemas', async () => {
    const schema: ConfigSchemaSection = {
      id: 'sample.config',
      title: 'Sample',
      tab: 'sample',
      configKey: '',
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
          publishConfigSurface(ctx, descriptor)
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
    system.subscribe(ConfigSchemaTopic, (event) => {
      if (event.type === 'config.schema') {
        const parsed = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload
        schemas.push(parsed.section)
      }
    })
    await tick()

    expect(schemas.at(-1)).toEqual(schema)

    system.stop(ref)
    await tick()

    expect(schemas.at(-1)).toEqual({ ...schema, schema: null })

    await system.shutdown()
  })
})

describe('deepMerge utility', () => {
  test('recursively merges nested properties', () => {
    const base = {
      a: 1,
      nested: { b: 2, c: 3 }
    }
    const override = {
      nested: { c: 4 }
    }
    expect(deepMerge(base, override)).toEqual({
      a: 1,
      nested: { b: 2, c: 4 }
    })
  })

  test('preserves explicit null overrides', () => {
    const base = {
      a: 1,
      nested: { b: 2, c: 3 }
    }
    const override = {
      nested: { b: null }
    }
    expect(deepMerge(base, override)).toEqual({
      a: 1,
      nested: { b: null, c: 3 }
    })
  })

  test('replaces arrays wholesale', () => {
    const base = {
      arr: [1, 2, 3]
    }
    const override = {
      arr: [4, 5]
    }
    expect(deepMerge(base, override)).toEqual({
      arr: [4, 5]
    })
  })

  test('handles undefined override values by keeping base', () => {
    const base = {
      a: 1
    }
    const override = {
      a: undefined
    }
    expect(deepMerge(base, override)).toEqual({
      a: 1
    })
  })
})
