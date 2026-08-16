import type { ShellState } from '../../frontend/shell/types.js'
import { describe, test, expect, beforeEach } from 'bun:test'

import { store } from '../../frontend/webkit/runtime/store.js'
import { resetStore } from '../helpers/frontend.js'

beforeEach(() => {
  localStorage.clear()
  resetStore()
})

describe('store: get and set', () => {
  test('get returns the current value', () => {
    expect(store.namespace<ShellState>('shell').get('isConnected')).toBe(false)
    expect(store.namespace<ShellState>('shell').get('activeWorkspaceTab')).toBe('none')
  })

  test('set updates the value', () => {
    store.namespace<ShellState>('shell').set('isConnected', true)
    expect(store.namespace<ShellState>('shell').get('isConnected')).toBe(true)
  })

  test('set triggers subscribers', () => {
    const calls: boolean[] = []
    store.namespace<ShellState>('shell').subscribe('isConnected', (v) => calls.push(v))
    store.namespace<ShellState>('shell').set('isConnected', true)
    store.namespace<ShellState>('shell').set('isConnected', false)
    expect(calls).toEqual([false, true, false])
  })

  test('set with same value does not notify', () => {
    let count = 0
    store.namespace<ShellState>('shell').subscribe('isConnected', () => count++)
    store.namespace<ShellState>('shell').set('isConnected', false) // same as default
    expect(count).toBe(1) // initial call from subscribe
  })
})

describe('store: subscribe', () => {
  test('subscriber is called immediately with current value', () => {
    store.namespace<ShellState>('shell').set('activeWorkspaceTab', 'config')
    const calls: string[] = []
    store.namespace<ShellState>('shell').subscribe('activeWorkspaceTab', (v) => calls.push(v))
    expect(calls).toEqual(['config'])
  })

  test('unsubscribe stops future notifications', () => {
    const calls: boolean[] = []
    const unsub = store.namespace<ShellState>('shell').subscribe('isConnected', (v) => calls.push(v))
    store.namespace<ShellState>('shell').set('isConnected', true)
    unsub()
    store.namespace<ShellState>('shell').set('isConnected', false)
    expect(calls).toEqual([false, true])
  })

  test('multiple subscribers for the same key', () => {
    const a: string[] = []
    const b: string[] = []
    store.namespace<ShellState>('shell').subscribe('activeWorkspaceTab', (v) => a.push(v))
    store.namespace<ShellState>('shell').subscribe('activeWorkspaceTab', (v) => b.push(v))
    store.namespace<ShellState>('shell').set('activeWorkspaceTab', 'observe')
    expect(a).toEqual(['none', 'observe'])
    expect(b).toEqual(['none', 'observe'])
  })
})

describe('store: namespace init', () => {
  test('namespace contains seeded keys after init', () => {
    const ns = store.namespace<ShellState>('shell')
    expect(ns.get('isConnected')).toBeDefined()
    expect(ns.get('messages')).toBeDefined()
    expect(ns.get('activeStream')).toBeDefined()
  })
})
