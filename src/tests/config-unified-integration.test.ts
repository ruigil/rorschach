import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { AgentSystem } from '../system/index.ts'
import { wireConfigManager } from '../config-set.ts'
import ConfigPlugin from '../plugins/config/config.plugin.ts'
import { ask } from '../system/index.ts'
import { unlinkSync } from 'node:fs'
import { RouteRegistrationTopic } from '../types/routes.ts'

const tempConfigPath = 'src/tests/temp-integration-config.json'

describe('Unified Config System End-to-End Integration', () => {
  let system: any
  let managerRef: any

  beforeAll(async () => {
    // 1. Setup initial config file
    await Bun.write(
      tempConfigPath,
      JSON.stringify(
        {
          plugins: ['./src/plugins/config/config.plugin.ts'],
          config: {
            cognitive: { model: 'gemini-3.6-flash' },
            auth: { enabled: true },
          },
        },
        null,
        2,
      ),
    )

    // 2. Start system with config plugin
    system = await AgentSystem({
      plugins: [ConfigPlugin],
      config: {
        cognitive: { model: 'gemini-3.6-flash' },
        auth: { enabled: true },
      },
    })

    // 3. Wire composition root manager
    wireConfigManager(system, tempConfigPath)

    // Find the spawned ConfigActor reference
    let resolveRef: any
    const promise = new Promise((resolve) => { resolveRef = resolve })
    const unsubscribe = system.subscribe(RouteRegistrationTopic, (event: any) => {
      if (event.path === '/config') {
        resolveRef(event.target)
      }
    })
    managerRef = await promise
    unsubscribe()
  })

  afterAll(async () => {
    if (system) {
      await system.shutdown()
    }
    try {
      unlinkSync(tempConfigPath)
    } catch {}
  })

  test('GET /config retrieves full configuration from file without state pollution', async () => {
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
    expect(body.cognitive).toEqual({ model: 'gemini-3.6-flash' })
    expect(body.auth).toEqual({ enabled: true })

    // Verify config.json does NOT contain the state-polluting dummy key ""
    const rawFileContents = await Bun.file(tempConfigPath).text()
    const parsedFile = JSON.parse(rawFileContents)
    expect(parsedFile.config['']).toBeUndefined()
  })

  test('GET /config/plugins retrieves actual running plugin summaries', async () => {
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
    
    // Config plugin must be active and in the list
    const cfg = list.find((p: any) => p.id === 'config')
    expect(cfg).toBeDefined()
    expect(cfg.status).toBe('active')
    expect(cfg.health).toBeDefined()
  })

  test('GET /config/values/:pluginId retrieves slice of plugin configuration', async () => {
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

  test('PATCH /config/values/ with empty pluginId fails fast and does not touch disk', async () => {
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
    const body = JSON.parse(res.response.body)
    expect(body.ok).toBe(false)
    expect(body.error).toContain('pluginId')

    // Disk untouched — no empty-key pollution
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

    // Disk untouched — no empty-key pollution via the tool path either
    const rawFileContents = await Bun.file(tempConfigPath).text()
    expect(JSON.parse(rawFileContents).config['']).toBeUndefined()
  })

  test('PATCH /config/values/:pluginId updates values both in-memory and on-disk', async () => {
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

    const body = JSON.parse(res.response.body)
    expect(body.ok).toBe(true)

    // Check disk file is updated
    const rawFileContents = await Bun.file(tempConfigPath).text()
    const parsedFile = JSON.parse(rawFileContents)
    expect(parsedFile.config.cognitive).toEqual({ model: 'gemini-exp-1206', temperature: 0.7 })

    // Check that querying the API again returns the new values
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
