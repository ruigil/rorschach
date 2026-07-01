// Shell entrypoint — loaded by index.html via
//   <script type="module" src="/frontend/rorschach.js"></script>
//
// Imports trigger `@customElement` decorators (side-effect imports). Kit
// primitives come from the frontend/webkit barrel; shell components are imported
// individually. Plugin UI modules are NOT imported here — they are loaded
// by `pluginHost.init()`'s dynamic imports.

// WebUI-Kit primitives — triggers @customElement for r-icon, r-badge, ...
import '@rorschach/frontend/webkit/index.js'
// Markdown renderer config (kit utility wrapping global marked/katex/hljs)
import '@rorschach/frontend/webkit/markdown.js'

// Shell components — triggers @customElement for r-shell, r-view, ...
import './shell/r-shell.js'
import './shell/r-view.js'
import './shell/r-chat-panel.js'
import './shell/r-chat-input.js'
import './shell/r-config-form.js'
import './shell/r-mode-select.js'
import './shell/r-surface-error.js'
import './shell/r-welcome-dashboard.js'
import './shell/r-theme-select.js'

// Shell boot: store init, plugin-host
import { store } from '@rorschach/frontend/webkit/store.js'
import type { ShellState } from './types/state.js'
import { pluginHost } from './shell/plugin-host.js'
import { DEFAULT_OBSERVE_TAB } from './constants.js'
import { initTheme } from './shell/theme.js'

// ─── Shell namespace init ───
//
// plugin-host seeds the `views` map via `store.ensureView()` in `init()`.

// Apply the persisted theme before any component that reads it mounts. This
// also registers `theme` as a persisted key on the shell namespace.
initTheme()

store.namespace<ShellState>('shell').init({
  theme: 'eclipse',
  isConnected: false,
  isWaiting: false,
  currentUserId: null,
  currentUserRoles: [],
  agents: [],
  currentMode: '',
  currentModeDisplayName: '',
  topics: [],
  actors: [],
  logs: [],
  traces: [],
  usage: [],
  tools: {},
  messages: [],
  lastMessages: [],
  observeActiveTab: DEFAULT_OBSERVE_TAB,
  activeStream: {
    isActive: false,
    reasoning: '',
    text: '',
    sources: [],
    attachments: [],
  },
  views: {},
  activeWorkspaceTab: 'docs',
  sidebarWidth: 360,
}, {
  persist: ['theme', 'currentMode', 'activeWorkspaceTab', 'lastMessages', 'sidebarWidth'],
})

// Hydrate the in-memory message list from the persisted recent messages
// (stripped of attachment payloads) so the chat panel restores on refresh.
const shellNs = store.namespace<ShellState>('shell')
if (shellNs.get('messages').length === 0 && shellNs.get('lastMessages').length > 0) {
  shellNs.set('messages', shellNs.get('lastMessages'))
}

// Start the plugin-host (seeds config/observe views, starts mode
// watcher, dynamic-imports plugin UI modules).
await pluginHost.init()
console.log('Plugin host initialized, shell is ready.')

// The application is now bootstrapped by the <r-shell> component.
// It handles authentication fetching, session initialization,
// and WebSocket connection management.

// watch-test edit
