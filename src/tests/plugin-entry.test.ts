import { describe, test, expect } from 'bun:test'
import {
  identityOf,
} from '../system/node/converge.ts'
import {
  applyDesiredPatch,
  configRevisionOf,
  revisionOf,
} from '../system/node/config-sources.ts'
import type { DesiredState } from '../system/node/types.ts'

describe('plugin-entry', () => {

  test('identityOf resolves path and preserves nonce', () => {
    expect(identityOf({ modulePath: '/abs/p.ts' })).toEqual({
      resolvedPath: '/abs/p.ts',
      reloadNonce: undefined,
    })
    expect(
      identityOf({ modulePath: '/abs/p.ts', reloadNonce: 2 }),
    ).toEqual({
      resolvedPath: '/abs/p.ts',
      reloadNonce: 2,
    })
    const def = { id: 'plug', version: '1', slots: {}, actors: {} }
    expect(identityOf({ def: def as never, modulePath: '/abs/plug.ts' })).toEqual({
      resolvedPath: '/abs/plug.ts',
      id: 'plug',
    })
  })
})

describe('desired-patch', () => {
  test('applyDesiredPatch merges config and replaces plugins', () => {
    const curr: DesiredState = {
      plugins: [{ modulePath: './a.ts' }],
      config: { a: { x: 1, y: 2 }, b: { z: 3 } },
    }
    const next = applyDesiredPatch(curr, {
      plugins: [{ modulePath: './b.ts' }],
      config: { a: { y: 9 } },
    })
    expect(next.plugins).toEqual([{ modulePath: './b.ts' }])
    expect(next.config).toEqual({ a: { x: 1, y: 9 }, b: { z: 3 } })
  })

  test('revisionOf stable for equivalent serializable docs', () => {
    const a: DesiredState = {
      plugins: [{ modulePath: './p.ts', reloadNonce: 1 }],
      config: { x: 1 },
    }
    const b: DesiredState = {
      plugins: [{ modulePath: './p.ts', reloadNonce: 1 }],
      config: { x: 1 },
    }
    expect(revisionOf(a)).toBe(revisionOf(b))
  })

  test('configRevisionOf ignores plugins; stable for same config', () => {
    const cfg = { a: { x: 1 }, b: { y: 2 } }
    expect(configRevisionOf(cfg)).toBe(configRevisionOf({ a: { x: 1 }, b: { y: 2 } }))
    // Full document revision changes when plugins change; config revision does not.
    const withPluginsA: DesiredState = { plugins: [{ modulePath: './a.ts' }], config: cfg }
    const withPluginsB: DesiredState = { plugins: [{ modulePath: './b.ts' }], config: cfg }
    expect(revisionOf(withPluginsA)).not.toBe(revisionOf(withPluginsB))
    expect(configRevisionOf(withPluginsA.config)).toBe(configRevisionOf(withPluginsB.config))
    expect(configRevisionOf(cfg)).not.toBe(configRevisionOf({ a: { x: 2 } }))
  })
})
