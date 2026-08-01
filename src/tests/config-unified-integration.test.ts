import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { AgentSystem, fileSource, ask } from '../system/index.ts'
import { unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { RouteRegistrationTopic } from '../types/routes.ts'

const tempConfigPath = resolve('src/tests/temp-integration-config.json')
const configPluginPath = resolve('src/plugins/config/config.plugin.ts')

const waitFor = async (pred: () => boolean | Promise<boolean>, timeoutMs = 4000) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return
    await Bun.sleep(50)
  }
  throw new Error('waitFor timeout')
}

describe('Unified Config System End-to-End Integration', () => {
  let system: any
  let managerRef: any
  let source: ReturnType<typeof fileSource>

  beforeAll(async () => {
    await Bun.write(
      tempConfigPath,
      JSON.stringify(
        {
          plugins: [{ modulePath: configPluginPath }],
          config: {
            config: { configPath: tempConfigPath },
            cognitive: { model: 'gemini-3.6-flash' },
            auth: { enabled: true },
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

    // Keep latest non-null manager ref (reload publishes tombstone then re-register).
    system.subscribe(RouteRegistrationTopic, (event: any) => {
      if (event.path === '/config' && event.target) managerRef = event.target
    })

    await source.write(() => ({
      plugins: [{ modulePath: configPluginPath, reloadNonce: 1 }],
    }))

    await waitFor(() => {
      const plugins = system.control().snapshotActual().plugins ?? []
      return Boolean(managerRef) && plugins.some((p: any) => p.id === 'config' && p.status === 'active')
    })
    await Bun.sleep(100)
  })

  afterAll(async () => {
    if (system) await system.shutdown()
    try {
      unlinkSync(tempConfigPath)
    } catch {
      /* ignore */
    }
  })

  test('GET /config retrieves full configuration from file', async () => {
    const res = await ask<any, any>(managerRef, (replyTo) => ({
      type: 'http.request',
      request: {
        method: 'GET',
        url: '/config',
        headers: {},
        body: null,
      },
      identity: null,
      replyTo,
    }))

    expect(res.type).toBe('http.response')
    expect(res.response.status).toBe(200)

    const body = JSON.parse(res.response.body)
    // GET /config returns desired config tree (keyed by plugin id)
    expect(body.cognitive).toEqual({ model: 'gemini-3.6-flash' })
    expect(body.auth).toEqual({ enabled: true })

    const rawFileContents = await Bun.file(tempConfigPath).text()
    const parsedFile = JSON.parse(rawFileContents)
    expect(parsedFile.config['']).toBeUndefined()
  })

  test('GET /config/plugins retrieves observed plugin summaries', async () => {
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

    const list = JSON.parse(res.response.body)
    expect(Array.isArray(list)).toBe(true)
    const cfg = list.find((p: any) => p.id === 'config')
    expect(cfg).toBeDefined()
    expect(cfg.status).toBe('active')
  })

  test('GET /config/values/:pluginId retrieves desired slice', async () => {
    const res = await ask<any, any>(managerRef, (replyTo) => ({
      type: 'http.request',
      request: {
        method: 'GET',
        url: '/config/values/cognitive',
        headers: {},
        body: null,
      },
      identity: null,
      replyTo,
    }))

    expect(res.type).toBe('http.response')
    expect(res.response.status).toBe(200)
    const cognitiveConfig = JSON.parse(res.response.body)
    expect(cognitiveConfig).toEqual({ model: 'gemini-3.6-flash' })
  })

  test('PATCH /config/values/ with empty pluginId fails fast', async () => {
    const diskBefore = await Bun.file(tempConfigPath).text()

    const res = await ask<any, any>(managerRef, (replyTo) => ({
      type: 'http.request',
      request: {
        method: 'PATCH',
        url: '/config/values/',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'pollution-attempt' }),
      },
      identity: null,
      replyTo,
    }))

    expect(res.type).toBe('http.response')
    expect(res.response.status).toBe(400)

    const diskAfter = await Bun.file(tempConfigPath).text()
    expect(diskAfter).toBe(diskBefore)
    expect(JSON.parse(diskAfter).config['']).toBeUndefined()
  })

  test('config_set tool with empty pluginId returns toolError', async () => {
    const res = await ask<any, any>(managerRef, (replyTo) => ({
      type: 'tool.invoke',
      toolCallId: 'tc-empty-1',
      toolName: 'config_set',
      args: { pluginId: '', patch: { foo: 'bar' } },
      replyTo,
    }))

    expect(res.type).toBe('toolError')
    expect(res.error).toContain('pluginId')

    const rawFileContents = await Bun.file(tempConfigPath).text()
    expect(JSON.parse(rawFileContents).config['']).toBeUndefined()
  })

  test('PATCH /config/values/:pluginId updates disk and desired reads', async () => {
    const res = await ask<any, any>(managerRef, (replyTo) => ({
      type: 'http.request',
      request: {
        method: 'PATCH',
        url: '/config/values/cognitive',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gemini-exp-1206', temperature: 0.7 }),
      },
      identity: null,
      replyTo,
    }))

    expect(res.type).toBe('http.response')
    expect(res.response.status).toBe(200)

    await waitFor(async () => {
      const raw = await Bun.file(tempConfigPath).text()
      const parsed = JSON.parse(raw)
      return parsed.config?.cognitive?.model === 'gemini-exp-1206'
    })

    const rawFileContents = await Bun.file(tempConfigPath).text()
    const parsedFile = JSON.parse(rawFileContents)
    expect(parsedFile.config.cognitive).toEqual({ model: 'gemini-exp-1206', temperature: 0.7 })

    const queryRes = await ask<any, any>(managerRef, (replyTo) => ({
      type: 'http.request',
      request: {
        method: 'GET',
        url: '/config/values/cognitive',
        headers: {},
        body: null,
      },
      identity: null,
      replyTo,
    }))
    const activeValues = JSON.parse(queryRes.response.body)
    expect(activeValues).toEqual({ model: 'gemini-exp-1206', temperature: 0.7 })
  })
})
