import { describe, test, expect } from 'bun:test'
import { framesFromObservedDiff } from '../plugins/config/observed-frames.ts'
import type { ObservedState } from '../system/node/types.ts'

const base = (over: Partial<ObservedState> & Pick<ObservedState, 'plugins'>): ObservedState => ({
  systemId: 'local',
  revision: 'rev-a',
  appliedRevision: 'rev-a',
  updatedAt: 1,
  ...over,
})

describe('framesFromObservedDiff (PR-8)', () => {
  test('first retain: add frames for all plugins + config.updated', () => {
    const next = base({
      plugins: [
        { id: 'config', version: '1', status: 'active' },
        { id: 'cognitive', version: '1', status: 'active' },
      ],
    })
    const frames = framesFromObservedDiff(null, next)
    expect(frames.filter((f) => f.type === 'plugins.updated')).toEqual([
      { type: 'plugins.updated', key: 'local', payload: { action: 'add', id: 'config' } },
      { type: 'plugins.updated', key: 'local', payload: { action: 'add', id: 'cognitive' } },
    ])
    expect(frames.filter((f) => f.type === 'config.updated')).toEqual([
      {
        type: 'config.updated',
        key: 'local',
        payload: { revision: 'rev-a', appliedRevision: 'rev-a' },
      },
    ])
  })

  test('plugin add/remove only', () => {
    const prev = base({
      plugins: [{ id: 'a', version: '1', status: 'active' }],
    })
    const next = base({
      plugins: [
        { id: 'a', version: '1', status: 'active' },
        { id: 'b', version: '1', status: 'active' },
      ],
    })
    const frames = framesFromObservedDiff(prev, next)
    expect(frames).toEqual([
      { type: 'plugins.updated', key: 'local', payload: { action: 'add', id: 'b' } },
    ])

    const removed = framesFromObservedDiff(next, prev)
    expect(removed).toEqual([
      { type: 'plugins.updated', key: 'local', payload: { action: 'remove', id: 'b' } },
    ])
  })

  test('revision / applied lag emits config.updated without plugin frames', () => {
    const prev = base({
      revision: 'r1',
      appliedRevision: 'r1',
      plugins: [{ id: 'a', version: '1', status: 'active' }],
    })
    const next = base({
      revision: 'r2',
      appliedRevision: 'r1',
      plugins: [{ id: 'a', version: '1', status: 'active' }],
    })
    expect(framesFromObservedDiff(prev, next)).toEqual([
      {
        type: 'config.updated',
        key: 'local',
        payload: { revision: 'r2', appliedRevision: 'r1' },
      },
    ])
  })

  test('identical snapshots → no frames', () => {
    const snap = base({
      plugins: [{ id: 'a', version: '1', status: 'active' }],
    })
    expect(framesFromObservedDiff(snap, { ...snap })).toEqual([])
  })
})
