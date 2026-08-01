import { describe, test, expect } from 'bun:test'
import { converge } from '../system/node/converge.ts'
import type { DesiredState } from '../system/node/types.ts'
import type { ConvergeActual } from '../system/node/converge.ts'

const emptyActual = (): ConvergeActual => ({ plugins: [] })

describe('converge()', () => {
  test('empty desired + empty actual → []', () => {
    const desired: DesiredState = { plugins: [], config: {} }
    expect(converge(desired, emptyActual(), { configChanged: false })).toEqual([])
  })

  test('desired plugins only → Loads in file order', () => {
    const desired: DesiredState = {
      plugins: [{ modulePath: '/abs/a.ts' }, { modulePath: '/abs/b.ts' }, { modulePath: '/abs/c.ts' }],
      config: {},
    }
    const ops = converge(desired, emptyActual(), {
      configChanged: false,
    })
    expect(ops.map((o) => o.type)).toEqual(['Load', 'Load', 'Load'])
    expect(ops).toEqual([
      { type: 'Load', entry: { modulePath: '/abs/a.ts' } },
      { type: 'Load', entry: { modulePath: '/abs/b.ts' } },
      { type: 'Load', entry: { modulePath: '/abs/c.ts' } },
    ])
  })

  test('extra actual plugin → Unload that id', () => {
    const desired: DesiredState = { plugins: [{ modulePath: '/abs/keep.ts' }], config: {} }
    const actual: ConvergeActual = {
      plugins: [
        {
          id: 'keep',
          status: 'active',
          modulePath: '/abs/keep.ts',
        },
        {
          id: 'extra',
          status: 'active',
          modulePath: '/abs/extra.ts',
        },
      ],
    }
    const ops = converge(desired, actual, {
      configChanged: false,
    })
    expect(ops).toEqual([{ type: 'Unload', id: 'extra' }])
  })

  test('actual without matching desired is unloaded', () => {
    const desired: DesiredState = { plugins: [], config: {} }
    const actual: ConvergeActual = {
      plugins: [
        { id: 'inline-test', status: 'active', modulePath: '/abs/inline-test.ts' },
        { id: 'config', status: 'active', modulePath: '/abs/config.plugin.ts' },
      ],
    }
    expect(converge(desired, actual, { configChanged: false })).toEqual([
      { type: 'Unload', id: 'inline-test' },
      { type: 'Unload', id: 'config' },
    ])
  })

  test('specifier change (unmatched path) → Unload + Load', () => {
    const desired: DesiredState = { plugins: [{ modulePath: '/abs/new.ts' }], config: {} }
    const actual: ConvergeActual = {
      plugins: [
        {
          id: 'plug',
          status: 'active',
          modulePath: '/abs/old.ts',
        },
      ],
    }
    // Match by path won't match new; actual has old path only.
    // Desired wants /abs/new.ts → Load. Old actual unmatched by path → Unload.
    const ops = converge(desired, actual, {
      configChanged: false,
    })
    expect(ops.map((o) => o.type)).toEqual(['Unload', 'Load'])
    expect(ops[0]).toEqual({ type: 'Unload', id: 'plug' })
    expect(ops[1]).toEqual({ type: 'Load', entry: { modulePath: '/abs/new.ts' } })
  })

  test('path change same materialised id → Unload + Load', () => {
    const def = { id: 'plug', version: '1.0.0', slots: {}, actors: {} }
    const desired: DesiredState = {
      plugins: [{ def: def as never, modulePath: '/abs/new.ts' }],
      config: {},
    }
    const actual: ConvergeActual = {
      plugins: [
        {
          id: 'plug',
          status: 'active',
          modulePath: '/abs/old.ts',
        },
      ],
    }
    const ops = converge(desired, actual, { configChanged: false })
    expect(ops).toEqual([
      { type: 'Unload', id: 'plug' },
      { type: 'Load', entry: { def: def as never, modulePath: '/abs/new.ts' } },
    ])
  })

  test('reloadNonce change → Unload + Load', () => {
    const desired: DesiredState = {
      plugins: [{ modulePath: '/abs/p.ts', reloadNonce: 2 }],
      config: {},
    }
    const actual: ConvergeActual = {
      plugins: [
        {
          id: 'p',
          status: 'active',
          modulePath: '/abs/p.ts',
          reloadNonce: 1,
        },
      ],
    }
    const ops = converge(desired, actual, {
      configChanged: false,
    })
    expect(ops).toEqual([
      { type: 'Unload', id: 'p' },
      { type: 'Load', entry: { modulePath: '/abs/p.ts', reloadNonce: 2 } },
    ])
  })

  test('configChanged → single ApplyConfig with full target', () => {
    const desired: DesiredState = {
      plugins: [],
      config: { a: { x: 1 }, b: { y: 2 } },
    }
    const ops = converge(desired, emptyActual(), { configChanged: true })
    expect(ops).toEqual([{ type: 'ApplyConfig', tree: { a: { x: 1 }, b: { y: 2 } } }])
  })

  test('plugin-only when configChanged false → Loads without ApplyConfig', () => {
    // First boot already applied config; plugin-only desired edit leaves configChanged false.
    const desired: DesiredState = {
      plugins: [{ modulePath: '/abs/new.ts' }],
      config: { a: { x: 1 } },
    }
    const ops = converge(desired, emptyActual(), {
      configChanged: false,
    })
    expect(ops.map((o) => o.type)).toEqual(['Load'])
    expect(ops).toEqual([{ type: 'Load', entry: { modulePath: '/abs/new.ts' } }])
  })

  test('first boot configChanged true → ApplyConfig even with empty plugins', () => {
    const desired: DesiredState = { plugins: [], config: { boot: { ok: true } } }
    const ops = converge(desired, emptyActual(), { configChanged: true })
    expect(ops).toEqual([{ type: 'ApplyConfig', tree: { boot: { ok: true } } }])
  })

  test('no-op when already matched', () => {
    const desired: DesiredState = {
      plugins: [{ modulePath: '/abs/p.ts' }],
      config: { p: { n: 1 } },
    }
    const actual: ConvergeActual = {
      plugins: [
        {
          id: 'p',
          status: 'active',
          modulePath: '/abs/p.ts',
        },
      ],
    }
    expect(
      converge(desired, actual, {
        configChanged: false,
      }),
    ).toEqual([])
  })

  test('order: Unloads (incl. identity-change) → ApplyConfig → Loads (desired order)', () => {
    const desired: DesiredState = {
      plugins: [
        { modulePath: '/abs/keep.ts' },
        { modulePath: '/abs/new.ts' },
        { modulePath: '/abs/reload.ts', reloadNonce: 3 },
      ],
      config: { x: 1 },
    }
    const actual: ConvergeActual = {
      plugins: [
        {
          id: 'keep',
          status: 'active',
          modulePath: '/abs/keep.ts',
        },
        {
          id: 'gone',
          status: 'active',
          modulePath: '/abs/gone.ts',
        },
        {
          id: 'reload',
          status: 'active',
          modulePath: '/abs/reload.ts',
          reloadNonce: 1,
        },
      ],
    }
    const ops = converge(desired, actual, {
      configChanged: true,
    })
    // Identity-change unload for reload joins unload phase; re-load joins loads
    // in desired index order (after new.ts). Removed plugins unload after identity-change unloads.
    expect(ops.map((o) => o.type)).toEqual([
      'Unload',
      'Unload',
      'ApplyConfig',
      'Load',
      'Load',
    ])
    expect(ops[0]).toEqual({ type: 'Unload', id: 'reload' })
    expect(ops[1]).toEqual({ type: 'Unload', id: 'gone' })
    expect(ops[2]).toEqual({ type: 'ApplyConfig', tree: { x: 1 } })
    expect(ops[3]).toEqual({ type: 'Load', entry: { modulePath: '/abs/new.ts' } })
    expect(ops[4]).toEqual({
      type: 'Load',
      entry: { modulePath: '/abs/reload.ts', reloadNonce: 3 },
    })
  })

  test('failed actual + desired present → Load', () => {
    const desired: DesiredState = { plugins: [{ modulePath: '/abs/p.ts' }], config: {} }
    const actual: ConvergeActual = {
      plugins: [
        {
          id: 'p',
          status: 'failed',
          modulePath: '/abs/p.ts',
        },
      ],
    }
    const ops = converge(desired, actual, {
      configChanged: false,
    })
    expect(ops).toEqual([{ type: 'Load', entry: { modulePath: '/abs/p.ts' } }])
  })

  test('mixed add/remove/config → deterministic op list', () => {
    const desired: DesiredState = {
      plugins: [{ modulePath: '/abs/a.ts' }, { modulePath: '/abs/b.ts' }],
      config: { a: { v: 1 } },
    }
    const actual: ConvergeActual = {
      plugins: [
        {
          id: 'a',
          status: 'active',
          modulePath: '/abs/a.ts',
        },
        {
          id: 'old',
          status: 'active',
          modulePath: '/abs/old.ts',
        },
      ],
    }
    const ops = converge(desired, actual, {
      configChanged: true,
    })
    expect(ops).toEqual([
      { type: 'Unload', id: 'old' },
      { type: 'ApplyConfig', tree: { a: { v: 1 } } },
      { type: 'Load', entry: { modulePath: '/abs/b.ts' } },
    ])
  })
})
