import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { AgentSystem, type ActorRef } from '../system/index.ts'
import { wireConfigManager } from '../config-set.ts'
import { SystemConfigUpdateTopic, type SystemConfigUpdateResult, type SystemConfigUpdateRequest } from '../types/config.ts'
import { unlinkSync } from 'node:fs'

const tempConfigPath = 'src/tests/temp-config-set.json'
const tempPluginPath = 'src/tests/temp-config-set-plugin.ts'

const askTopic = <Request, Response>(
  system: any,
  topic: any,
  messageFactory: (replyTo: ActorRef<Response>) => Request,
): Promise<Response> => {
  return new Promise<Response>((resolve) => {
    const replyTo: ActorRef<Response> = {
      name: `ask-topic:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      isAlive: () => true,
      send: (res: Response) => resolve(res),
    }
    system.publish(topic, messageFactory(replyTo))
  })
}

describe('wireConfigManager Composition Root Listener', () => {
  let system: any

  beforeAll(async () => {
    await Bun.write(
      tempConfigPath,
      JSON.stringify(
        {
          plugins: [],
          config: {},
        },
        null,
        2,
      ),
    )

    await Bun.write(
      tempPluginPath,
      `
      export default {
        id: 'temp-config-set-plugin',
        version: '1.0.0',
        initialState: () => ({ count: 0 }),
        handler: (state: any) => ({ state })
      }
    `,
    )

    system = await AgentSystem()
    wireConfigManager(system, tempConfigPath)
    await Bun.sleep(20)
  })

  afterAll(async () => {
    await system.shutdown()
    try {
      unlinkSync(tempConfigPath)
      unlinkSync(tempPluginPath)
    } catch {}
  })

  test('set_value updates system config and persists patch to file', async () => {
    const res = await askTopic<SystemConfigUpdateRequest, SystemConfigUpdateResult>(
      system,
      SystemConfigUpdateTopic,
      (replyTo) => ({
        action: 'set_value',
        pluginId: 'temp_plugin',
        patch: { enabled: true, mode: 'auto' },
        replyTo,
      }),
    )

    expect(res.success).toBe(true)

    const raw = await Bun.file(tempConfigPath).text()
    const parsed = JSON.parse(raw)
    expect(parsed.config.temp_plugin).toEqual({ enabled: true, mode: 'auto' })
  })

  test('set_value with empty pluginId is rejected (defense in depth)', async () => {
    const res = await askTopic<SystemConfigUpdateRequest, SystemConfigUpdateResult>(
      system,
      SystemConfigUpdateTopic,
      (replyTo) => ({
        action: 'set_value',
        pluginId: '',
        patch: { enabled: true },
        replyTo,
      }),
    )

    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error).toContain('pluginId')
    }

    const raw = await Bun.file(tempConfigPath).text()
    expect(JSON.parse(raw).config['']).toBeUndefined()
  })

  test('set_value keeps raw env placeholders out of the runtime config tree', async () => {
    const res = await askTopic<SystemConfigUpdateRequest, SystemConfigUpdateResult>(
      system,
      SystemConfigUpdateTopic,
      (replyTo) => ({
        action: 'set_value',
        pluginId: 'placeholder_plugin',
        patch: { apiKey: '${RORSCHACH_TEST_MISSING_VAR}', count: 5 },
        replyTo,
      }),
    )

    expect(res.success).toBe(true)

    // Runtime holds only the real values — the placeholder was stripped
    expect(system.getConfigSlice('placeholder_plugin')).toEqual({ count: 5 })

    // Disk keeps the full raw patch (placeholders are idempotent on disk)
    const raw = await Bun.file(tempConfigPath).text()
    const parsed = JSON.parse(raw)
    expect(parsed.config.placeholder_plugin).toEqual({ apiKey: '${RORSCHACH_TEST_MISSING_VAR}', count: 5 })
  })

  test('add_plugin loads plugin into substrate and appends specifier to file', async () => {
    const res = await askTopic<SystemConfigUpdateRequest, SystemConfigUpdateResult>(
      system,
      SystemConfigUpdateTopic,
      (replyTo) => ({
        action: 'add_plugin',
        specifier: './temp-config-set-plugin.ts',
        replyTo,
      }),
    )

    if (!res.success) {
      console.error('add_plugin error:', res)
    }

    expect(res.success).toBe(true)
    expect(system.getPluginStatus('temp-config-set-plugin')?.status).toBe('active')

    const raw = await Bun.file(tempConfigPath).text()
    const parsed = JSON.parse(raw)
    expect(parsed.plugins).toContain('./temp-config-set-plugin.ts')
  })

  test('reload_plugin reloads active plugin', async () => {
    const res = await askTopic<SystemConfigUpdateRequest, SystemConfigUpdateResult>(
      system,
      SystemConfigUpdateTopic,
      (replyTo) => ({
        action: 'reload_plugin',
        pluginId: 'temp-config-set-plugin',
        replyTo,
      }),
    )

    expect(res.success).toBe(true)
  })

  test('remove_plugin unloads plugin and removes specifier from file', async () => {
    const res = await askTopic<SystemConfigUpdateRequest, SystemConfigUpdateResult>(
      system,
      SystemConfigUpdateTopic,
      (replyTo) => ({
        action: 'remove_plugin',
        pluginId: 'temp-config-set-plugin',
        replyTo,
      }),
    )

    expect(res.success).toBe(true)
    expect(system.getPluginStatus('temp-config-set-plugin')).toBeUndefined()

    const raw = await Bun.file(tempConfigPath).text()
    const parsed = JSON.parse(raw)
    expect(parsed.plugins).not.toContain(`./${tempPluginPath}`)
  })

  test('prevents unloading core plugin config', async () => {
    const res = await askTopic<SystemConfigUpdateRequest, SystemConfigUpdateResult>(
      system,
      SystemConfigUpdateTopic,
      (replyTo) => ({
        action: 'remove_plugin',
        pluginId: 'config',
        replyTo,
      }),
    )

    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error).toContain('Cannot unload core plugin')
    }
  })
})
