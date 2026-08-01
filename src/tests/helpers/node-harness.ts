import { onLifecycle, type PluginDef, type PluginSystem } from '../../system/index.ts'
import { unlinkSync } from 'node:fs'
import { resolve } from 'node:path'

// ─── Shared helpers for node-control / boot / secrets tests (PR-9) ───────────

/** Poll until `pred` is true or throw after `timeoutMs`. */
export const waitFor = async (
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
  intervalMs = 50,
): Promise<void> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return
    await Bun.sleep(intervalMs)
  }
  throw new Error('waitFor timeout')
}

/** Plugin ids from the actual snapshot (test internals). */
export const pluginIds = (system: PluginSystem): string[] =>
  (system.control().snapshotActual().plugins ?? []).map((p) => p.id)

/** One plugin row from the actual snapshot, or undefined. */
export const statusOf = (system: PluginSystem, id: string) =>
  system.control().snapshotActual().plugins.find((p) => p.id === id)

/** Minimal in-memory PluginDef (optional start failure). */
export const makePlugin = (id: string, fail = false): PluginDef<any, any> => ({
  id,
  version: '1.0.0',
  initialState: null,
  lifecycle: onLifecycle({
    start(state) {
      if (fail) throw new Error(`fail ${id}`)
      return { state }
    },
  }),
  handler: (state) => ({ state }),
})

/** Absolute path under src/tests/ for ephemeral fixtures. */
export const tempTestPath = (...parts: string[]): string =>
  resolve('src/tests', ...parts)

/** Write a minimal default-export plugin file; returns absolute path. */
export const writeTempPluginFile = async (
  absPath: string,
  opts: { id: string; version?: string; body?: string },
): Promise<string> => {
  const version = opts.version ?? '1.0.0'
  const body =
    opts.body ??
    `
export default {
  id: ${JSON.stringify(opts.id)},
  version: ${JSON.stringify(version)},
  initialState: () => ({ count: 0 }),
  handler: (state) => ({ state }),
}
`
  await Bun.write(absPath, body)
  return absPath
}

/** Best-effort unlink for temp fixtures (ignore missing). */
export const unlinkQuiet = (...paths: string[]): void => {
  for (const p of paths) {
    try {
      unlinkSync(p)
    } catch {
      /* ignore */
    }
  }
}
