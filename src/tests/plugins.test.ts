import { describe, test, expect } from 'bun:test'
import { AgentSystem, ask, fileSource } from '../system/index.ts'
import { RouteRegistrationTopic } from '../types/routes.ts'
import { unlinkSync } from 'node:fs'
import { resolve } from 'node:path'

const tick = (ms = 50) => Bun.sleep(ms)

const configPluginPath = resolve('src/plugins/config/config.plugin.ts')

/** Boot from file, then reload config plugin so late RouteRegistration subscribers catch the manager. */
const bootConfigManager = async (tempPath: string) => {
  await Bun.write(
    tempPath,
    JSON.stringify(
      {
        plugins: [configPluginPath],
        config: { config: { configPath: tempPath } },
      },
      null,
      2,
    ) + '\n',
  )

  const source = fileSource(tempPath)
  const system = await AgentSystem({ source })

  let managerRef: any
  system.subscribe(RouteRegistrationTopic, (event: any) => {
    if (event.path === '/config' && event.target) managerRef = event.target
  })

  await source.write(() => ({
    plugins: [{ modulePath: configPluginPath, reloadNonce: 1 }],
  }))
  await tick(400)
  // Latest non-null registration after reload cycle
  expect(managerRef).toBeDefined()
  return { system, source, managerRef }
}

describe('Config Actor & Routes & Tools (desired plane)', () => {
  test('GET /config/plugins yields observed plugin list', async () => {
    const tempPath = resolve('src/tests/temp-plugins-test-config.json')
    const { system, managerRef } = await bootConfigManager(tempPath)

    const res = await ask<any, any>(managerRef, (replyTo) => ({
      type: 'http.request',
      request: {
        method: 'GET',
        url: '/config/plugins',
        headers: {},
        body: null,
      },
      identity: null,
      replyTo,
    }))

    expect(res.type).toBe('http.response')
    expect(res.response.status).toBe(200)
    const body = JSON.parse(res.response.body)
    expect(Array.isArray(body)).toBe(true)
    const cfg = body.find((p: any) => p.id === 'config')
    expect(cfg).toBeDefined()
    expect(cfg.status).toBe('active')

    await system.shutdown()
    try {
      unlinkSync(tempPath)
    } catch {
      /* ignore */
    }
  })

  test('plugins_load tool writes desired state', async () => {
    const tempPath = resolve('src/tests/temp-plugins-tool-config.json')
    const { system, managerRef } = await bootConfigManager(tempPath)

    const reply = await ask<any, any>(managerRef, (replyTo) => ({
      type: 'tool.invoke',
      toolCallId: 'call-1',
      toolName: 'plugins_load',
      args: { modulePath: './analytics.ts' },
      replyTo,
    }))
    expect(reply.type).toBe('toolResult')
    expect(reply.result).toContain('analytics')

    const raw = await Bun.file(tempPath).text()
    const parsed = JSON.parse(raw)
    expect(
      parsed.plugins.some(
        (p: any) => p === './analytics.ts' || p?.modulePath === './analytics.ts',
      ),
    ).toBe(true)

    await system.shutdown()
    try {
      unlinkSync(tempPath)
    } catch {
      /* ignore */
    }
  })
})
