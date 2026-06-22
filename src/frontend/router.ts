import { store } from '@rorschach/frontend/webkit/store.js'
import { TABS, DEFAULT_TAB } from './constants.js'
import type { Tab } from './constants.js'
import type { ShellState } from './types/state.js'

const shell = () => store.namespace<ShellState>('shell')

const TAB_TO_HASH: Record<Tab, string> = Object.fromEntries(
  TABS.map(tab => [tab, `#/${tab}`])
) as Record<Tab, string>

const HASH_TO_TAB: Record<string, Tab> = Object.fromEntries(
  TABS.map(tab => [`#/${tab}`, tab])
)

export function initRouter() {
  function syncHashToStore() {
    const tab = HASH_TO_TAB[window.location.hash] || DEFAULT_TAB
    if (shell().get('activeTab') !== tab) {
      shell().set('activeTab', tab)
    }
  }

  syncHashToStore()
  window.addEventListener('hashchange', syncHashToStore)

  shell().subscribe('activeTab', (activeTab) => {
    const expectedHash = TAB_TO_HASH[activeTab as Tab] || `#/${DEFAULT_TAB}`
    if (window.location.hash !== expectedHash) {
      window.location.hash = expectedHash
    }
  })
}
