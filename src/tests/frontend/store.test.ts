import { describe, test, expect, beforeEach } from 'bun:test'

import { store } from '../../frontend/store.js'
import { resetStore } from '../helpers/frontend.js'

beforeEach(() => {
  resetStore()
})

describe('store: get and set', () => {
  test('get returns the current value', () => {
    expect(store.get('isConnected')).toBe(false)
    expect(store.get('currentMode')).toBe('')
  })

  test('set updates the value', () => {
    store.set('isConnected', true)
    expect(store.get('isConnected')).toBe(true)
  })

  test('set triggers subscribers', () => {
    const calls: boolean[] = []
    store.subscribe('isConnected', (v) => calls.push(v))
    store.set('isConnected', true)
    store.set('isConnected', false)
    expect(calls).toEqual([false, true, false])
  })

  test('set with same value does not notify', () => {
    let count = 0
    store.subscribe('isConnected', () => count++)
    store.set('isConnected', false) // same as default
    expect(count).toBe(1) // initial call from subscribe
  })
})

describe('store: subscribe', () => {
  test('subscriber is called immediately with current value', () => {
    store.set('currentMode', 'chatbot')
    const calls: string[] = []
    store.subscribe('currentMode', (v) => calls.push(v))
    expect(calls).toEqual(['chatbot'])
  })

  test('unsubscribe stops future notifications', () => {
    const calls: boolean[] = []
    const unsub = store.subscribe('isConnected', (v) => calls.push(v))
    store.set('isConnected', true)
    unsub()
    store.set('isConnected', false)
    expect(calls).toEqual([false, true])
  })

  test('multiple subscribers for the same key', () => {
    const a: string[] = []
    const b: string[] = []
    store.subscribe('currentMode', (v) => a.push(v))
    store.subscribe('currentMode', (v) => b.push(v))
    store.set('currentMode', 'planner')
    expect(a).toEqual(['', 'planner'])
    expect(b).toEqual(['', 'planner'])
  })
})

describe('store: getState', () => {
  test('returns the full state object', () => {
    const state = store.getState()
    expect(state).toHaveProperty('isConnected')
    expect(state).toHaveProperty('messages')
    expect(state).toHaveProperty('activeStream')
  })
})
