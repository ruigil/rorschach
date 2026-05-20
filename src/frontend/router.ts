import { store } from './store.js'
import { TABS, DEFAULT_TAB } from './constants.js'
import type { Tab } from './constants.js'

const TAB_TO_HASH: Record<Tab, string> = Object.fromEntries(
  TABS.map(tab => [tab, `#/${tab}`])
) as Record<Tab, string>

const HASH_TO_TAB: Record<string, Tab> = Object.fromEntries(
  TABS.map(tab => [`#/${tab}`, tab])
)

export function initRouter() {
  function syncHashToStore() {
    const tab = HASH_TO_TAB[window.location.hash] || DEFAULT_TAB
    if (store.get('activeTab') !== tab) {
      store.set('activeTab', tab)
    }
  }

  syncHashToStore()
  window.addEventListener('hashchange', syncHashToStore)

  store.subscribe('activeTab', (activeTab) => {
    const expectedHash = TAB_TO_HASH[activeTab as Tab] || `#/${DEFAULT_TAB}`
    if (window.location.hash !== expectedHash) {
      window.location.hash = expectedHash
    }
  })
}
