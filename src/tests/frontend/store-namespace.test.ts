import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { store, __resetStoreForTests } from '../../frontend/webkit/store.js'
import { StoreController } from '../../frontend/webkit/store-controller.js'
import type { ShellState } from '../../frontend/types/state.js'

beforeEach(() => {
  __resetStoreForTests()
  localStorage.clear()
})

afterEach(() => {
  __resetStoreForTests()
  localStorage.clear()
})

// ─── store.namespace() isolation ───

describe('store.namespace() isolation', () => {
  test('set/get on one namespace does not leak to another', () => {
    interface FooState { value: string }
    interface BarState { value: string }

    store.namespace<FooState>('foo').set('value', 'hello')
    store.namespace<BarState>('bar').set('value', 'world')

    expect(store.namespace<FooState>('foo').get('value')).toBe('hello')
    expect(store.namespace<BarState>('bar').get('value')).toBe('world')
  })

  test('subscribe on one namespace does not fire for the same key on another', () => {
    interface FooState { messages: string[] }
    interface BarState { messages: string[] }

    const fooCalls: string[][] = []
    const barCalls: string[][] = []

    store.namespace<FooState>('foo').init({ messages: [] })
    store.namespace<BarState>('bar').init({ messages: [] })

    store.namespace<FooState>('foo').subscribe('messages', (v) => fooCalls.push(v))
    store.namespace<BarState>('bar').subscribe('messages', (v) => barCalls.push(v))

    // Setting foo.messages should fire foo subscriber only
    store.namespace<FooState>('foo').set('messages', ['a'])
    expect(fooCalls).toEqual([[], ['a']])
    expect(barCalls).toEqual([[]]) // only the initial fire, no update

    // Setting bar.messages should fire bar subscriber only
    store.namespace<BarState>('bar').set('messages', ['b'])
    expect(barCalls).toEqual([[], ['b']])
  })

  test('init seeds defaults only for absent keys', () => {
    interface S { a: string; b: string }
    const ns = store.namespace<S>('test')
    ns.init({ a: 'default-a', b: 'default-b' })
    expect(ns.get('a')).toBe('default-a')
    expect(ns.get('b')).toBe('default-b')

    // Overwriting 'a' then re-init should not reset 'a'
    ns.set('a', 'custom')
    ns.init({ a: 'default-a', b: 'default-b' })
    expect(ns.get('a')).toBe('custom')
  })

  test('init notifies subscribers that attached before init ran', () => {
    // Reproduces the shell boot timing: a Lit StoreController subscribes
    // during a custom-element upgrade (an import side-effect) before the
    // top-level store.namespace('shell').init({...}) call runs. Without
    // notify, the controller stays stuck on `undefined` and the shell never
    // re-renders with the seeded value.
    interface S { testField: string }
    const ns = store.namespace<S>('lateinit')
    const calls: (string | undefined)[] = []
    ns.subscribe('testField', (v) => calls.push(v))
    expect(calls).toEqual([undefined])

    ns.init({ testField: 'value' })
    expect(ns.get('testField')).toBe('value')
    expect(calls).toEqual([undefined, 'value'])
  })

  test('reset deletes the namespace and drops listeners', () => {
    interface S { count: number }
    const ns = store.namespace<S>('resettest')
    ns.init({ count: 0 })
    const calls: number[] = []
    ns.subscribe('count', (v) => calls.push(v))
    ns.set('count', 1)
    expect(calls).toEqual([0, 1])

    ns.reset()
    // After reset, getting a key returns undefined
    expect((store.namespace<S>('resettest') as any).get('count')).toBeUndefined()
  })
})

// ─── store.namespace() persistence ───

describe('store.namespace() persistence', () => {
  test('set writes to localStorage for a persisted key', () => {
    interface S { width: number }
    const ns = store.namespace<S>('persist-write')
    ns.init({ width: 34 }, { persist: ['width'] })
    ns.set('width', 55)
    expect(localStorage.getItem('rorschach.store.persist-write.width')).toBe('55')
  })

  test('init reads saved localStorage value for a persisted key', () => {
    localStorage.setItem('rorschach.store.persist-read.width', '62')
    interface S { width: number }
    const ns = store.namespace<S>('persist-read')
    ns.init({ width: 34 }, { persist: ['width'] })
    expect(ns.get('width')).toBe(62)
  })

  test('init falls back to default when no localStorage entry exists', () => {
    interface S { width: number }
    const ns = store.namespace<S>('persist-default')
    ns.init({ width: 34 }, { persist: ['width'] })
    expect(ns.get('width')).toBe(34)
  })

  test('non-persisted keys are not written to localStorage', () => {
    interface S { a: number; b: number }
    const ns = store.namespace<S>('persist-selective')
    ns.init({ a: 1, b: 2 }, { persist: ['a'] })
    ns.set('a', 10)
    ns.set('b', 20)
    expect(localStorage.getItem('rorschach.store.persist-selective.a')).toBe('10')
    expect(localStorage.getItem('rorschach.store.persist-selective.b')).toBeNull()
  })

  test('reset clears persisted key registration so set no longer writes', () => {
    interface S { width: number }
    const ns = store.namespace<S>('persist-reset')
    ns.init({ width: 34 }, { persist: ['width'] })
    ns.set('width', 55)
    expect(localStorage.getItem('rorschach.store.persist-reset.width')).toBe('55')

    ns.reset()
    localStorage.removeItem('rorschach.store.persist-reset.width')

    // Re-create the namespace without persist and set — should not write
    store.namespace<S>('persist-reset').set('width', 99)
    expect(localStorage.getItem('rorschach.store.persist-reset.width')).toBeNull()
  })

  test('__resetStoreForTests clears persisted key registrations', () => {
    interface S { width: number }
    store.namespace<S>('persist-testreset').init({ width: 34 }, { persist: ['width'] })
    __resetStoreForTests()
    // After full reset, set on the same namespace should not write to localStorage
    store.namespace<S>('persist-testreset').set('width', 77)
    expect(localStorage.getItem('rorschach.store.persist-testreset.width')).toBeNull()
  })
})

// ─── store.ensureView / closeView ───

describe('store.ensureView / closeView', () => {
  test('ensureView seeds view runtime state with defaults', () => {
    store.ensureView('testview', {
      id: 'testview', title: 'Test', icon: 'file', contentTag: 'r-test',
    })
    const view = store.namespace<ShellState>('shell').get('views')['testview']
    expect(view).toBeDefined()
    expect(view!.id).toBe('testview')
  })

  test('ensureView is idempotent', () => {
    const cfg = {
      id: 'idem', title: 'T', icon: 'file', contentTag: 'r-t',
    }
    store.ensureView('idem', cfg)
    const first = store.namespace<ShellState>('shell').get('views')['idem']
    store.ensureView('idem', cfg)
    const second = store.namespace<ShellState>('shell').get('views')['idem']
    expect(first).toBe(second) // same object reference
  })

  test('closeView sets isOpen to false', () => {
    store.ensureView('closeme', {
      id: 'closeme', title: 'C', icon: 'file', contentTag: 'r-c',
    })
    store.namespace<ShellState>('shell').get('views')['closeme']!.isOpen = true
    store.closeView('closeme')
    expect(store.namespace<ShellState>('shell').get('views')['closeme']!.isOpen).toBe(false)
  })
})

// ─── StoreController two-element path ───

describe('StoreController two-element path', () => {
  test('binds to a namespace key and updates on set', () => {
    interface TestState { mode: string }

    // A minimal fake host that implements ReactiveControllerHost
    let updateRequested = false
    const fakeHost = {
      addController: () => {},
      removeController: () => {},
      requestUpdate: () => { updateRequested = true },
      hasUpdated: true,
      isConnected: true,
    }

    store.namespace<TestState>('ctrltest').init({ mode: 'initial' })
    const ctrl = new StoreController<TestState, 'mode'>(fakeHost as any, ['ctrltest', 'mode'])
    expect(ctrl.value).toBe('initial')

    // Simulate hostConnected
    ;(ctrl as any).hostConnected()

    store.namespace<TestState>('ctrltest').set('mode', 'changed')
    expect(ctrl.value).toBe('changed')
    expect(updateRequested).toBe(true)

    // Simulate hostDisconnected
    ;(ctrl as any).hostDisconnected()
  })
})
