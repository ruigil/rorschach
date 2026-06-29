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

// Shell components — triggers @customElement for r-shell, r-window, ...
import './shell/r-shell.js'
import './shell/r-window.js'
import './shell/r-chat-panel.js'
import './shell/r-chat-input.js'
import './shell/r-config-form.js'
import './shell/r-observe-panel.js'
import './shell/r-mode-select.js'
import './shell/r-surface-error.js'
import './shell/r-welcome-dashboard.js'

// Shell boot: corona animation, router, store init, plugin-host
import './corona.js'
import { initRouter } from './router.js'
import { store } from '@rorschach/frontend/webkit/store.js'
import type { ShellState } from './types/state.js'
import { pluginHost } from './shell/plugin-host.js'
import { DEFAULT_TAB, DEFAULT_OBSERVE_TAB } from './constants.js'

// ─── Shell namespace init ───
//
// Seed the shell namespace with defaults. The shell is just another namespace
// owner, symmetric with `store.namespace('<pluginId>')` for plugins. The
// plugin-host seeds the `windows` map via `store.ensureWindow()` in `init()`.

const savedMessagesStr = typeof localStorage !== 'undefined' ? localStorage.getItem('rorschach.lastMessages') : null
let savedMessages: ShellState['messages'] = []
if (savedMessagesStr) {
  try { savedMessages = JSON.parse(savedMessagesStr) } catch { /* ignore */ }
}

const savedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('rorschach.currentMode') || '' : ''
const savedActiveWorkspaceTab = typeof localStorage !== 'undefined' ? localStorage.getItem('rorschach.activeWorkspaceTab') || 'docs' : 'docs'

store.namespace<ShellState>('shell').init({
  isConnected: false,
  isWaiting: false,
  currentUserId: null,
  currentUserRoles: [],
  agents: [],
  currentMode: savedMode,
  currentModeDisplayName: '',
  topics: [],
  actors: [],
  logs: [],
  traces: [],
  usage: [],
  tools: {},
  ws: null,
  messages: savedMessages,
  activeTab: DEFAULT_TAB,
  observeActiveTab: DEFAULT_OBSERVE_TAB,
  activeStream: {
    isActive: false,
    reasoning: '',
    text: '',
    sources: [],
    attachments: [],
  },
  windows: {},
  activeWindowIds: [],
  activeWorkspaceTab: savedActiveWorkspaceTab,
})

// Start the plugin-host (seeds chat/docs/workflows windows, starts mode
// watcher, dynamic-imports legacy plugin UI modules).
await pluginHost.init()
console.log('Plugin host initialized, shell is ready.')
initRouter()

// The application is now bootstrapped by the <r-shell> component.
// It handles authentication fetching, session initialization,
// and WebSocket connection management.

// watch-test edit
