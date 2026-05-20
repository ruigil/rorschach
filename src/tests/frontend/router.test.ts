import { describe, test, expect, beforeEach, afterEach } from 'bun:test'

import { store } from '../../frontend/store.js'
import { resetStore } from '../helpers/frontend.js'

beforeEach(() => {
  resetStore()
  window.location.hash = ''
})

afterEach(() => {
  window.location.hash = ''
})

describe('router', () => {
  test('initRouter syncs hash to store on load', async () => {
    window.location.hash = '#/config'
    const { initRouter } = await import('../../frontend/router.js')
    initRouter()
    expect(store.get('activeTab')).toBe('config')
  })

  test('initRouter defaults to chat for unknown hash', async () => {
    window.location.hash = '#/unknown'
    const { initRouter } = await import('../../frontend/router.js')
    initRouter()
    expect(store.get('activeTab')).toBe('chat')
  })

  test('store activeTab change updates hash', async () => {
    const { initRouter } = await import('../../frontend/router.js')
    initRouter()
    store.set('activeTab', 'observe')
    expect(window.location.hash).toBe('#/observe')
  })
})
