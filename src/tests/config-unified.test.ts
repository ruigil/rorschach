import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { saveConfigUnified, loadConfig } from '../config.ts'
import { unlinkSync } from 'node:fs'

const tempConfigPath = 'src/tests/temp-unified-config.json'

describe('saveConfigUnified Persistence & Concurrency', () => {
  beforeAll(async () => {
    await Bun.write(tempConfigPath, JSON.stringify({
      plugins: ['./src/plugins/cognitive/cognitive.plugin.ts'],
      config: {
        cognitive: { model: 'gemini-3.6-flash' },
      },
    }, null, 2))
  })

  afterAll(() => {
    try {
      unlinkSync(tempConfigPath)
    } catch {}
  })

  test('updates both plugins and config atomically', async () => {
    await saveConfigUnified(tempConfigPath, (curr) => ({
      plugins: [...curr.plugins, './src/plugins/auth/auth.plugin.ts'],
      config: {
        auth: { secret: 'supersecret' },
      },
    }))

    const raw = await Bun.file(tempConfigPath).text()
    const parsed = JSON.parse(raw)

    expect(parsed.plugins).toEqual([
      './src/plugins/cognitive/cognitive.plugin.ts',
      './src/plugins/auth/auth.plugin.ts',
    ])
    expect(parsed.config).toEqual({
      cognitive: { model: 'gemini-3.6-flash' },
      auth: { secret: 'supersecret' },
    })
  })

  test('handles high concurrency without lost updates or file corruption', async () => {
    const promises: Promise<void>[] = []

    for (let i = 0; i < 20; i++) {
      if (i % 2 === 0) {
        promises.push(
          saveConfigUnified(tempConfigPath, (curr) => ({
            plugins: [...curr.plugins, `plugin-${i}.ts`],
          }))
        )
      } else {
        promises.push(
          saveConfigUnified(tempConfigPath, (curr) => ({
            config: { [`key_${i}`]: i * 100 },
          }))
        )
      }
    }

    await Promise.all(promises)

    const raw = await Bun.file(tempConfigPath).text()
    const parsed = JSON.parse(raw)

    // Check all plugin additions were saved
    for (let i = 0; i < 20; i += 2) {
      expect(parsed.plugins).toContain(`plugin-${i}.ts`)
    }

    // Check all config parameter additions were saved
    for (let i = 1; i < 20; i += 2) {
      expect(parsed.config[`key_${i}`]).toBe(i * 100)
    }
  })

  test('serializes concurrent saveConfigUnified calls seamlessly', async () => {
    const p1 = saveConfigUnified(tempConfigPath, (curr) => ({ config: { custom: { setting: true } } }))
    const p2 = saveConfigUnified(tempConfigPath, (curr) => ({ plugins: [...curr.plugins, 'interop-plugin.ts'] }))
    const p3 = saveConfigUnified(tempConfigPath, (curr) => ({ config: { custom: { setting2: 42 } } }))

    await Promise.all([p1, p2, p3])

    const raw = await Bun.file(tempConfigPath).text()
    const parsed = JSON.parse(raw)

    expect(parsed.plugins).toContain('interop-plugin.ts')
    expect(parsed.config.custom).toEqual({ setting: true, setting2: 42 })
  })

  test('recovers and continues working even if a single updater fails in the queue', async () => {
    const p1 = saveConfigUnified(tempConfigPath, (curr) => ({ config: { custom: { normal: 1 } } }))
    const p2 = saveConfigUnified(tempConfigPath, (curr) => {
      throw new Error('Updater failure simulated')
    })
    const p3 = saveConfigUnified(tempConfigPath, (curr) => ({ config: { custom: { after: 2 } } }))

    await expect(p1).resolves.toBeUndefined()
    await expect(p2).rejects.toThrow('Updater failure simulated')
    await expect(p3).resolves.toBeUndefined()

    const raw = await Bun.file(tempConfigPath).text()
    const parsed = JSON.parse(raw)
    expect(parsed.config.custom.normal).toBe(1)
    expect(parsed.config.custom.after).toBe(2)
  })
})
