import { describe, test, expect } from 'bun:test'
import {
  AgentSystem,
  staticSource,
  fileSource,
  onLifecycle,
  type PluginDef,
} from '../system/index.ts'
import { resolve } from 'node:path'
import {
  waitFor,
  pluginIds,
  statusOf,
  makePlugin,
  unlinkQuiet,
} from './helpers/node-harness.ts'

describe('node boot (phase 4 — first converge)', () => {
  test('empty static source resolves; no plugins', async () => {
    const system = await AgentSystem({ source: staticSource({}) })
    expect(pluginIds(system)).toEqual([])
    await system.shutdown()
  })

  test('no source → bare kernel', async () => {
    const system = await AgentSystem()
    expect(pluginIds(system)).toEqual([])
    await system.shutdown()
  })

  test('populated static: plugins active in order; config applied', async () => {
    const a = makePlugin('boot-a')
    const b = makePlugin('boot-b')
    const system = await AgentSystem({
      source: staticSource({
        plugins: [a, b],
        config: { 'boot-a': { n: 1 } },
      }),
    })

    expect(pluginIds(system)).toEqual(['boot-a', 'boot-b'])
    expect(statusOf(system, 'boot-a')?.status).toBe('active')
    expect(statusOf(system, 'boot-b')?.status).toBe('active')
    const cfg = system.control().snapshotActual().config
    expect((cfg as any)['boot-a']?.n).toBe(1)

    await system.shutdown()
  })

  test('populated file: same via temp config.json', async () => {
    const tempPath = resolve('src/tests/temp-node-boot.json')
    const pluginPath = resolve('src/tests/temp-node-boot-plugin.ts')
    await Bun.write(
      pluginPath,
      `
      export default {
        id: 'file-boot-plugin',
        version: '1.0.0',
        initialState: () => ({}),
        handler: (state) => ({ state }),
      }
    `,
    )
    await Bun.write(
      tempPath,
      JSON.stringify(
        {
          plugins: [{ modulePath: pluginPath }],
          config: { 'file-boot-plugin': { ok: true } },
        },
        null,
        2,
      ) + '\n',
    )

    const system = await AgentSystem({
      source: fileSource(tempPath),
    })
    expect(pluginIds(system)).toContain('file-boot-plugin')
    expect(statusOf(system, 'file-boot-plugin')?.status).toBe('active')
    const cfg = system.control().snapshotActual().config
    expect((cfg as any)['file-boot-plugin']?.ok).toBe(true)

    await system.shutdown()
    unlinkQuiet(tempPath, pluginPath)
  })

  test('first plugin fails: failed entry + others active; construct resolves', async () => {
    const bad = makePlugin('boot-bad', true)
    const good = makePlugin('boot-good')
    const system = await AgentSystem({
      source: staticSource({ plugins: [bad, good] }),
    })

    expect(statusOf(system, 'boot-bad')?.status).toBe('failed')
    expect(statusOf(system, 'boot-good')?.status).toBe('active')
    // Both plugins are loaded and present in status
    expect(statusOf(system, 'boot-bad')).toBeDefined()
    expect(statusOf(system, 'boot-good')).toBeDefined()

    await system.shutdown()
  })

  test('failed plugin can be removed and retried via desired', async () => {
    let shouldThrow = true
    const plugin: PluginDef<any, any> = {
      id: 'retry-plugin',
      version: '1.0.0',
      initialState: null,
      lifecycle: onLifecycle({
        start(state) {
          if (shouldThrow) throw new Error('intentional startup failure')
          return { state }
        },
      }),
      handler: (state) => ({ state }),
    }

    const source = staticSource({ plugins: [plugin] })
    const system = await AgentSystem({ source })
    expect(statusOf(system, 'retry-plugin')?.status).toBe('failed')

    await source.write(() => ({ plugins: [] }))
    await waitFor(() => statusOf(system, 'retry-plugin') === undefined)

    shouldThrow = false
    await source.write(() => ({ plugins: [plugin] }))
    await waitFor(() => statusOf(system, 'retry-plugin')?.status === 'active')

    await system.shutdown()
  })

  test('source read throws: construct still resolves (soft-fail)', async () => {
    const source = {
      read: async () => {
        throw new Error('read boom')
      },
      write: async () => ({ revision: '' }),
      watch: () => () => {},
    }
    const system = await AgentSystem({ source })
    expect(pluginIds(system)).toEqual([])
    await system.shutdown()
  })

  test('source read fails then recovers on retry: plugins load without duplicates', async () => {
    const a = makePlugin('recover-a')
    let fail = true
    const inner = staticSource({ plugins: [a] })
    const source = {
      read: async () => {
        if (fail) throw new Error('temp unavailable')
        return inner.read()
      },
      write: inner.write.bind(inner),
      watch: inner.watch.bind(inner),
    }
    const system = await AgentSystem({ source })
    expect(pluginIds(system)).toEqual([])

    fail = false
    await waitFor(() => pluginIds(system).includes('recover-a'), 5000)
    expect(statusOf(system, 'recover-a')?.status).toBe('active')
    expect(pluginIds(system).filter((id) => id === 'recover-a')).toHaveLength(1)

    // Re-converge when already matched is a no-op (no duplicates).
    await source.write((curr: { plugins: unknown[]; config: unknown }) => ({
      plugins: curr.plugins as never,
      config: curr.config as never,
    }))
    await Bun.sleep(200)
    expect(pluginIds(system).filter((id) => id === 'recover-a')).toHaveLength(1)

    await system.shutdown()
  })

  test('deepMerge null overrides at boot config', async () => {
    const plugin: PluginDef<any, any, any> = {
      id: 'test-merge',
      version: '1.0.0',
      configDescriptor: {
        defaults: {
          enabled: true,
          nested: {
            value: 42,
            keep: 'original',
          },
        },
      },
      initialState: null,
      handler: (state) => ({ state }),
    }

    const system = await AgentSystem({
      source: staticSource({
        plugins: [plugin],
        config: {
          'test-merge': {
            enabled: null,
            nested: {
              value: null,
              keep: 'original',
            },
          },
        },
      }),
    })

    expect(statusOf(system, 'test-merge')?.status).toBe('active')
    await system.shutdown()
  })

  // ─── PR-5: loadPlugin is an idempotent effector; converge owns path unload ───

  test('loadPlugin hard-errors on active path conflict (no silent unload)', async () => {
    const def = makePlugin('path-conflict')
    const system = await AgentSystem({}) // bare kernel — no node-control
    const internals = system.control()

    const r1 = await internals.loadPlugin({ def, modulePath: '/abs/old.ts' })
    expect(r1.ok).toBe(true)
    expect(statusOf(system, 'path-conflict')?.modulePath).toBe('/abs/old.ts')

    const r2 = await internals.loadPlugin({ def, modulePath: '/abs/new.ts' })
    expect(r2.ok).toBe(false)
    if (!r2.ok) {
      expect(r2.error).toContain('converge must Unload first')
      expect(r2.error).toContain('/abs/new.ts')
    }
    // Still at old path — loadPlugin did not mini-converge.
    expect(statusOf(system, 'path-conflict')?.modulePath).toBe('/abs/old.ts')
    expect(statusOf(system, 'path-conflict')?.status).toBe('active')

    await system.shutdown()
  })

  test('path change via desired → converge Unload then Load', async () => {
    const def = makePlugin('path-change')
    const source = staticSource({
      plugins: [{ def, modulePath: '/abs/old.ts' }],
    })
    const system = await AgentSystem({ source })

    expect(statusOf(system, 'path-change')?.status).toBe('active')
    expect(statusOf(system, 'path-change')?.modulePath).toBe('/abs/old.ts')

    await source.write(() => ({
      plugins: [{ def, modulePath: '/abs/new.ts' }],
    }))
    await waitFor(() => statusOf(system, 'path-change')?.modulePath === '/abs/new.ts')

    expect(statusOf(system, 'path-change')?.status).toBe('active')
    expect(statusOf(system, 'path-change')?.modulePath).toBe('/abs/new.ts')

    await system.shutdown()
  })

  test('loadPlugin same-path no-op is still ok', async () => {
    const def = makePlugin('same-path')
    const system = await AgentSystem({})
    const internals = system.control()

    expect((await internals.loadPlugin({ def, modulePath: '/abs/p.ts' })).ok).toBe(true)
    const again = await internals.loadPlugin({ def, modulePath: '/abs/p.ts' })
    expect(again.ok).toBe(true)
    expect(again.id).toBe('same-path')
    expect(pluginIds(system).filter((id) => id === 'same-path')).toHaveLength(1)

    await system.shutdown()
  })

  test('boot with alternate path: admin + control both on that absolute file', async () => {
    const tempPath = resolve('src/tests/temp-pr7-boot-alt.json')
    const configPluginPath = resolve('src/plugins/config/config.plugin.ts')
    await Bun.write(
      tempPath,
      JSON.stringify(
        {
          plugins: [{ modulePath: configPluginPath }],
          config: {
            config: { configPath: tempPath },
          },
        },
        null,
        2,
      ) + '\n',
    )

    const source = fileSource(tempPath)
    const system = await AgentSystem({ source })
    await waitFor(() => statusOf(system, 'config')?.status === 'active')

    const { state: after } = await source.read()
    expect((after.config.config as { configPath?: string })?.configPath).toBe(tempPath)

    await system.shutdown()
    unlinkQuiet(tempPath)
  })

  // ─── PR-6: configChanged from config-subtree hash ─────────────────────────

  test('plugin-only desired write does not re-notify via applyConfig', async () => {
    let configNotifyCount = 0
    const watcher: PluginDef<any, any, any> = {
      id: 'cfg-watch',
      version: '1.0.0',
      configDescriptor: {
        defaults: { n: 0 },
        onConfigChange: (c: { n: number }) => {
          configNotifyCount++
          return { type: 'config', slice: c }
        },
      },
      initialState: null,
      handler: (state: unknown) => ({ state }),
    }
    const peer = makePlugin('peer-only')

    const source = staticSource({
      plugins: [watcher],
      config: { 'cfg-watch': { n: 1 } },
    })
    const system = await AgentSystem({ source })
    expect(statusOf(system, 'cfg-watch')?.status).toBe('active')
    // Boot ApplyConfig may or may not notify depending on slice equality at load;
    // capture baseline after settle.
    await Bun.sleep(50)
    const afterBoot = configNotifyCount

    // Plugin-only: add peer — config subtree unchanged → no ApplyConfig.
    await source.write((curr) => ({
      plugins: [...curr.plugins, peer],
    }))
    await waitFor(() => statusOf(system, 'peer-only')?.status === 'active')
    await Bun.sleep(50)
    expect(configNotifyCount).toBe(afterBoot)

    // Config patch: should ApplyConfig and notify watcher.
    await source.write(() => ({
      config: { 'cfg-watch': { n: 2 } },
    }))
    await waitFor(() => {
      const cfg = system.control().snapshotActual().config as any
      return cfg?.['cfg-watch']?.n === 2
    })
    await Bun.sleep(50)
    expect(configNotifyCount).toBeGreaterThan(afterBoot)

    await system.shutdown()
  })
})
