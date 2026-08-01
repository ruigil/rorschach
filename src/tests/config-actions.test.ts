import { describe, test, expect, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { staticSource } from '../system/node/config-sources.ts'
import {
  getConfig,
  setConfig,
  addPlugin,
  removePlugin,
  reloadPlugin,
} from '../plugins/config/manager.ts'
import type { PluginSummary } from '../plugins/config/types.ts'

const pluginA = resolve('src/plugins/config/config.plugin.ts')

describe('Config Action Handlers', () => {
  let source: ReturnType<typeof staticSource>
  let observedPlugins: PluginSummary[]

  beforeEach(() => {
    source = staticSource({
      plugins: [{ modulePath: pluginA }],
      config: {
        cognitive: { model: 'gemini-3.6-flash' },
        auth: { enabled: true },
      },
    })
    observedPlugins = [
      {
        id: 'config',
        version: '1.0.0',
        status: 'active',
        modulePath: pluginA,
      },
    ]
  })

  test('getConfig full tree', async () => {
    const result = await getConfig(source)
    expect(result).toEqual({
      cognitive: { model: 'gemini-3.6-flash' },
      auth: { enabled: true },
    })
  })

  test('getConfig plugin slice', async () => {
    const result = await getConfig(source, 'cognitive')
    expect(result).toEqual({ model: 'gemini-3.6-flash' })
  })

  test('getConfig missing plugin → empty object', async () => {
    const result = await getConfig(source, 'missing')
    expect(result).toEqual({})
  })

  test('setConfig writes and returns revision', async () => {
    const result = await setConfig(source, 'cognitive', { model: 'new-model', temperature: 0.5 })
    expect(typeof result.revision).toBe('string')
    expect(result.revision.length).toBeGreaterThan(0)

    const { state: desired } = await source.read()
    expect(desired.config.cognitive).toEqual({ model: 'new-model', temperature: 0.5 })
  })

  test('addPlugin', async () => {
    const path = './src/plugins/other.ts'
    const result = await addPlugin(source, path)
    expect(typeof result.revision).toBe('string')

    const { state: desired } = await source.read()
    expect(desired.plugins.some((p) => typeof p === 'object' && 'modulePath' in p && p.modulePath === path)).toBe(true)
  })

  test('removePlugin', async () => {
    const result = await removePlugin(source, 'config', observedPlugins)
    expect(typeof result.revision).toBe('string')

    const { state: desired } = await source.read()
    expect(desired.plugins).toHaveLength(0)
  })

  test('reloadPlugin bumps nonce', async () => {
    const result = await reloadPlugin(source, 'config', observedPlugins)
    expect(result.found).toBe(true)
    expect(typeof result.revision).toBe('string')

    const { state: desired } = await source.read()
    const entry = desired.plugins[0]
    expect(entry && typeof entry === 'object' && 'reloadNonce' in entry && entry.reloadNonce).toBe(1)
  })

  test('reloadPlugin not in desired → found is false', async () => {
    const result = await reloadPlugin(source, 'ghost', observedPlugins)
    expect(result.found).toBe(false)
  })
})
