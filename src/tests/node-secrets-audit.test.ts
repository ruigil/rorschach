import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
  AgentSystem,
  fileSource,
  type PluginSystem,
  ask,
} from '../system/index.ts'
import { SystemObservedTopic } from '../types/config.ts'
import { OutboundAdminBroadcastTopic } from '../types/events.ts'
import { RouteRegistrationTopic } from '../types/routes.ts'
import type { ObservedState } from '../system/node/types.ts'
import { resolve } from 'node:path'
import { waitFor, tempTestPath, unlinkQuiet } from './helpers/node-harness.ts'

const tempConfigPath = tempTestPath('temp-node-secrets.json')
const configPluginPath = resolve('src/plugins/config/config.plugin.ts')
const SECRET_ENV = 'RORSCHACH_SECRETS_AUDIT_KEY'
const SECRET_VALUE = 'super-secret-value-do-not-leak-9f3a'

describe('secrets audit (phase 3)', () => {
  let system: PluginSystem
  let source: ReturnType<typeof fileSource>
  let managerRef: any
  let lastObserved: ObservedState | undefined
  const wsFrames: any[] = []

  beforeAll(async () => {
    process.env[SECRET_ENV] = SECRET_VALUE

    await Bun.write(
      tempConfigPath,
      JSON.stringify(
        {
          plugins: [configPluginPath],
          config: {
            config: { configPath: tempConfigPath },
            secrets_plugin: {
              apiKey: `\${${SECRET_ENV}}`,
              publicName: 'ok',
            },
          },
        },
        null,
        2,
      ) + '\n',
    )

    source = fileSource(tempConfigPath)
    system = await AgentSystem({
      source,
    })

    system.subscribe(SystemObservedTopic, (e) => {
      lastObserved = e
    })
    system.subscribe(OutboundAdminBroadcastTopic, (e) => {
      wsFrames.push(e)
    })

    system.subscribe(RouteRegistrationTopic, (event: any) => {
      if (event.path === '/config' && event.target) managerRef = event.target
    })

    await source.write(() => ({
      plugins: [{ modulePath: configPluginPath, reloadNonce: 1 }],
    }))

    await waitFor(() => {
      const cfg = system.control().snapshotActual().config as any
      return Boolean(managerRef) && cfg?.secrets_plugin?.publicName === 'ok'
    })
    await Bun.sleep(100)
  })

  afterAll(async () => {
    delete process.env[SECRET_ENV]
    await system.shutdown()
    unlinkQuiet(tempConfigPath)
  })

  test('live actual plane interpolates the secret (control plane only)', () => {
    const live = system.control().snapshotActual().config as any
    expect(live.secrets_plugin.apiKey).toBe(SECRET_VALUE)
  })

  test('GET /config/values serves raw desired placeholder, not secret', async () => {
    const res = await ask<any, any>(managerRef, (replyTo) => ({
      type: 'http.request',
      request: {
        method: 'GET',
        url: '/config/values/secrets_plugin',
        headers: {},
        body: null,
      },
      identity: null,
      replyTo,
    }))
    expect(res.response.status).toBe(200)
    const body = JSON.parse(res.response.body)
    expect(body.apiKey).toBe(`\${${SECRET_ENV}}`)
    expect(JSON.stringify(body)).not.toContain(SECRET_VALUE)
  })

  test('config_get tool returns raw desired, not secret', async () => {
    const res = await ask<any, any>(managerRef, (replyTo) => ({
      type: 'invoke',
      toolName: 'config_get',
      arguments: JSON.stringify({ pluginId: 'secrets_plugin' }),
      userId: 'test',
      replyTo,
    }))
    expect(res.type).toBe('toolResult')
    expect(res.result.text).toContain(`\${${SECRET_ENV}}`)
    expect(res.result.text).not.toContain(SECRET_VALUE)
  })

  test('observed payload never contains resolved secret', async () => {
    await waitFor(() => lastObserved !== undefined)
    const serialized = JSON.stringify(lastObserved)
    expect(serialized).not.toContain(SECRET_VALUE)
    expect((lastObserved as any).config).toBeUndefined()
  })

  test('admin broadcast frames never contain resolved secret', async () => {
    const framesBefore = wsFrames.length
    await source.write((curr) => ({
      config: {
        ...curr.config,
        secrets_plugin: {
          apiKey: `\${${SECRET_ENV}}`,
          publicName: 'ok2',
        },
      },
    }))
    await waitFor(() => {
      const cfg = system.control().snapshotActual().config as any
      return cfg?.secrets_plugin?.publicName === 'ok2'
    })
    // PR-8: frames are derived by config plugin from observed (not by node-control).
    await waitFor(() =>
      wsFrames.slice(framesBefore).some((f) => f.type === 'config.updated'),
    )

    const serialized = JSON.stringify(wsFrames)
    expect(serialized).not.toContain(SECRET_VALUE)
    const updated = wsFrames.slice(framesBefore).filter((f) => f.type === 'config.updated')
    expect(updated.length).toBeGreaterThan(0)
    for (const f of updated) {
      expect(f.payload?.revision).toBeTruthy()
      expect(f.payload?.appliedRevision).toBeTruthy()
    }
  })
})
