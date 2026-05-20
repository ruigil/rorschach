import { store } from './store.js';

const HASH_TO_TAB: Record<string, string> = {
  '#/chat': 'chat',
  '#/config': 'config',
  '#/observe': 'observe',
};

const TAB_TO_HASH: Record<string, string> = {
  'chat': '#/chat',
  'config': '#/config',
  'observe': '#/observe',
};

export function initRouter() {
  // Sync state from hash
  function syncHashToStore() {
    const hash = window.location.hash;
    const tab = HASH_TO_TAB[hash] || 'chat';
    if (store.get('activeTab') !== tab) {
      store.set('activeTab', tab);
    }
  }

  // Run initial sync from URL to store
  syncHashToStore();

  // Listen for subsequent hash changes (e.g. back/forward button clicks)
  window.addEventListener('hashchange', syncHashToStore);

  // Sync state changes back to hash
  store.subscribe('activeTab', (activeTab) => {
    const expectedHash = TAB_TO_HASH[activeTab as string] || '#/chat';
    if (window.location.hash !== expectedHash) {
      window.location.hash = expectedHash;
    }
  });
}
