import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
  AgentSystem,
  fileSource,
  type PluginSystem,
} from '../system/index.ts'
import { SystemObservedTopic } from '../types/config.ts'
import type { ObservedState } from '../system/node/types.ts'
import {
  waitFor,
  statusOf,
  tempTestPath,
  writeTempPluginFile,
  unlinkQuiet,
} from './helpers/node-harness.ts'

const tempConfigPath = tempTestPath('temp-node-control.json')
const tempPluginPath = tempTestPath('temp-node-control-plugin.ts')
const reloadEditPluginPath = tempTestPath('temp-reload-edit-plugin.ts')

describe('node-control converge (level-triggered)', () => {
  let system: PluginSystem
  let source: ReturnType<typeof fileSource>
  let lastObserved: ObservedState | undefined

  beforeAll(async () => {
    await Bun.write(
      tempConfigPath,
      JSON.stringify({ plugins: [], config: {} }, null, 2) + '\n',
    )

    await writeTempPluginFile(tempPluginPath, { id: 'temp-node-control-plugin' })

    source = fileSource(tempConfigPath)
    system = await AgentSystem({
      source,
      systemId: 'test-node',
    })

    system.subscribe(SystemObservedTopic, (e) => {
      lastObserved = e
    })

    await waitFor(() => lastObserved !== undefined && lastObserved.appliedRevision !== '')
  })

  afterAll(async () => {
    await system.shutdown()
    unlinkQuiet(tempConfigPath, tempPluginPath, reloadEditPluginPath)
  })

  test('source.write config → converge applies config', async () => {
    await source.write(() => ({
      config: { temp_plugin: { enabled: true, mode: 'auto' } },
    }))

    await waitFor(() => {
      const cfg = system.control().snapshotActual().config
      return (cfg as any)?.temp_plugin?.enabled === true
    })

    const raw = await Bun.file(tempConfigPath).text()
    const parsed = JSON.parse(raw)
    expect(parsed.config.temp_plugin).toEqual({ enabled: true, mode: 'auto' })
  })

  test('applyConfig replaces full target tree (deletes absent top-level keys)', async () => {
    await source.write(() => ({
      config: {
        keep_slice: { a: 1 },
        drop_slice: { b: 2 },
      },
    }))
    await waitFor(() => {
      const cfg = system.control().snapshotActual().config as any
      return cfg?.keep_slice?.a === 1 && cfg?.drop_slice?.b === 2
    })

    // FileSource.write deep-merges patches, so a full target document (hand-edit
    // / absolute rewrite) is how top-level keys are removed from desired.
    const disk = JSON.parse(await Bun.file(tempConfigPath).text())
    disk.config = { keep_slice: { a: 1 } }
    await Bun.write(tempConfigPath, JSON.stringify(disk, null, 2) + '\n')
    // Kick converge (watch is a hint; write is reliable).
    await source.write((curr) => ({ plugins: curr.plugins }))

    await waitFor(() => {
      const cfg = system.control().snapshotActual().config as any
      return cfg?.keep_slice?.a === 1 && cfg?.drop_slice === undefined
    })
  })

  test('source.write keeps raw env placeholders on disk; apply interpolates', async () => {
    await source.write(() => ({
      config: {
        placeholder_plugin: {
          apiKey: '${RORSCHACH_TEST_MISSING_VAR}',
          count: 5,
        },
      },
    }))

    await waitFor(() => {
      const cfg = system.control().snapshotActual().config
      return (cfg as any)?.placeholder_plugin?.count === 5
    })

    const live = system.control().snapshotActual().config
    expect((live as any).placeholder_plugin.count).toBe(5)

    const raw = await Bun.file(tempConfigPath).text()
    const parsed = JSON.parse(raw)
    expect(parsed.config.placeholder_plugin).toEqual({
      apiKey: '${RORSCHACH_TEST_MISSING_VAR}',
      count: 5,
    })
  })

  test('source.write plugins → converge loads plugin with applied on snapshot', async () => {
    await source.write(() => ({
      plugins: [{ modulePath: '${CONFIG_DIR}/temp-node-control-plugin.ts' }],
    }))

    await waitFor(() => {
      const plugins = system.control().snapshotActual().plugins ?? []
      return plugins.some((p) => p.id === 'temp-node-control-plugin' && p.status === 'active')
    })

    const loaded = system.control()
      .snapshotActual()
      .plugins.find((p) => p.id === 'temp-node-control-plugin')
    expect(loaded?.modulePath).toBeTruthy()

    const raw = await Bun.file(tempConfigPath).text()
    const parsed = JSON.parse(raw)
    // Write path normalizes bare strings to { specifier }.
    expect(parsed.plugins).toContainEqual({ modulePath: '${CONFIG_DIR}/temp-node-control-plugin.ts' })
  })

  test('reloadNonce bump → plugin reloads; applied lives on ActualSnapshot', async () => {
    await source.write(() => ({
      plugins: [{ modulePath: '${CONFIG_DIR}/temp-node-control-plugin.ts', reloadNonce: 1 }],
    }))

    await waitFor(() => {
      const p = statusOf(system, 'temp-node-control-plugin')
      return p?.status === 'active' && p.reloadNonce === 1
    })

    const mid = statusOf(system, 'temp-node-control-plugin')
    expect(mid?.modulePath).toBeTruthy()
    expect(mid?.reloadNonce).toBe(1)

    await source.write(() => ({
      plugins: [{ modulePath: '${CONFIG_DIR}/temp-node-control-plugin.ts', reloadNonce: 2 }],
    }))

    await waitFor(() => {
      const p = statusOf(system, 'temp-node-control-plugin')
      return p?.status === 'active' && p.reloadNonce === 2
    })

    const after = statusOf(system, 'temp-node-control-plugin')
    expect(after?.status).toBe('active')
    expect(after?.reloadNonce).toBe(2)
  })

  test('reload after nonce picks up file edits (PR-9 stable import + nonce bust)', async () => {
    await writeTempPluginFile(reloadEditPluginPath, {
      id: 'reload-edit-plugin',
      version: '1.0.0',
    })

    await source.write(() => ({
      plugins: [{ modulePath: '${CONFIG_DIR}/temp-reload-edit-plugin.ts', reloadNonce: 1 }],
    }))
    await waitFor(() => {
      const p = statusOf(system, 'reload-edit-plugin')
      return p?.status === 'active' && p.version === '1.0.0' && p.reloadNonce === 1
    })

    // Edit on disk without changing specifier — only a nonce bump reloads with bust.
    await writeTempPluginFile(reloadEditPluginPath, {
      id: 'reload-edit-plugin',
      version: '2.0.0',
    })

    await source.write(() => ({
      plugins: [{ modulePath: '${CONFIG_DIR}/temp-reload-edit-plugin.ts', reloadNonce: 2 }],
    }))
    await waitFor(() => {
      const p = statusOf(system, 'reload-edit-plugin')
      return p?.status === 'active' && p.version === '2.0.0' && p.reloadNonce === 2
    })

    expect(statusOf(system, 'reload-edit-plugin')?.version).toBe('2.0.0')
  })

  test('append plugin preserves peer reloadNonce entries', async () => {
    await source.write(() => ({
      plugins: [{ modulePath: '${CONFIG_DIR}/temp-node-control-plugin.ts', reloadNonce: 7 }],
    }))
    await waitFor(() => {
      const plugins = system.control().snapshotActual().plugins ?? []
      return plugins.some((p) => p.id === 'temp-node-control-plugin')
    })

    // Simulate admin addPlugin mutator: append without flattening peers.
    await source.write((curr) => {
      const has = curr.plugins.some(
        (p) =>
          typeof p === 'object' && 'modulePath' in p && p.modulePath === '${CONFIG_DIR}/other-plugin.ts',
      )
      return {
        plugins: has ? curr.plugins : [...curr.plugins, { modulePath: '${CONFIG_DIR}/other-plugin.ts' }],
      }
    })

    const raw = await Bun.file(tempConfigPath).text()
    const parsed = JSON.parse(raw)
    const nonceEntry = parsed.plugins.find(
      (p: unknown) =>
        typeof p === 'object' &&
        p !== null &&
        'modulePath' in p &&
        (p as { modulePath: string }).modulePath === '${CONFIG_DIR}/temp-node-control-plugin.ts',
    )
    expect(nonceEntry).toEqual({
      modulePath: '${CONFIG_DIR}/temp-node-control-plugin.ts',
      reloadNonce: 7,
    })
    // Appended bare strings are normalized to { modulePath } on write.
    expect(parsed.plugins).toContainEqual({ modulePath: '${CONFIG_DIR}/other-plugin.ts' })
  })

  test('source.write remove plugin → converge unloads', async () => {
    await source.write(() => ({
      plugins: [],
    }))

    await waitFor(() => {
      const plugins = system.control().snapshotActual().plugins ?? []
      return !plugins.some((p) => p.id === 'temp-node-control-plugin')
    })
  })

  test('observed topic is published after converge (no config tree)', async () => {
    expect(lastObserved).toBeDefined()
    expect(typeof lastObserved!.revision).toBe('string')
    expect(lastObserved!.revision).toBe(lastObserved!.appliedRevision)
    expect(Array.isArray(lastObserved!.plugins)).toBe(true)
    expect(Object.keys(lastObserved as object)).not.toContain('config')

    const before = lastObserved!.appliedRevision
    await source.write(() => ({
      config: { observe_probe: { ok: true } },
    }))
    await waitFor(
      () =>
        lastObserved !== undefined &&
        lastObserved.revision !== before &&
        lastObserved.revision === lastObserved.appliedRevision,
    )
  })

  test('systemId is retained key (late subscribe gets replay)', async () => {
    let replayed: ObservedState | undefined
    const unsub = system.subscribe(SystemObservedTopic, (e) => {
      replayed = e
    })
    await waitFor(() => replayed !== undefined)
    unsub()
    expect(replayed!.revision).toBe(lastObserved!.revision)
    expect(replayed!.appliedRevision).toBe(lastObserved!.appliedRevision)
  })

  test('concurrent writes serialize via FileSource queue; system converges', async () => {
    await Promise.all([
      source.write(() => ({ config: { serial_a: { n: 1 } } })),
      source.write(() => ({ config: { serial_b: { n: 2 } } })),
    ])

    await waitFor(() => {
      const cfg = system.control().snapshotActual().config as any
      return cfg?.serial_a?.n === 1 && cfg?.serial_b?.n === 2
    })
  })

  test('FileSource queue continues after updater failure', async () => {
    const p1 = source.write(() => ({ config: { queue_ok: { n: 1 } } }))
    const p2 = source.write(() => {
      throw new Error('Updater failure simulated')
    })
    const p3 = source.write(() => ({ config: { queue_after: { n: 2 } } }))

    await expect(p1).resolves.toBeDefined()
    await expect(p2).rejects.toThrow('Updater failure simulated')
    await expect(p3).resolves.toBeDefined()

    await waitFor(() => {
      const cfg = system.control().snapshotActual().config as any
      return cfg?.queue_ok?.n === 1 && cfg?.queue_after?.n === 2
    })
  })
})
