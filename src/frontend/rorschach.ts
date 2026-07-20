// Shell entrypoint — loaded by index.html via
//   <script type="module" src="/frontend/rorschach.js"></script>
//
// Imports trigger `@customElement` decorators (side-effect imports). Kit
// primitives come from the frontend/webkit barrel; shell components are imported
// individually. Plugin UI modules are NOT imported here — they are loaded
// by `pluginHost.init()`'s dynamic imports.

// WebUI-Kit primitives — triggers @customElement for r-icon, r-badge, ...
import { store } from '@rorschach/webkit';
import type { ShellState } from './shell/types.js'

// ─── Shell namespace init ───
// Initialize the namespace before upgrading any shell components so
// they can safely subscribe and get values during connection/construction.
store.namespace<ShellState>('shell').init({
  theme: 'eclipse',
  isConnected: false,
  isWaiting: false,
  currentUserId: null,
  currentUserRoles: [],
  agents: [],
  currentMode: '',
  currentModeDisplayName: '',
  messages: [],
  lastMessages: [],
  activeStream: {
    isActive: false,
    reasoning: '',
    text: '',
    sources: [],
    attachments: [],
    toolCalls: [],
  },
  views: {},
  activeWorkspaceTab: 'none',
  workspaceTabOrder: [],
  sidebarWidth: 360,
}, {
  persist: ['theme', 'currentMode', 'activeWorkspaceTab', 'workspaceTabOrder', 'lastMessages', 'sidebarWidth'],
})

// Markdown renderer config (kit utility wrapping global marked/katex/hljs)
//import '@rorschach/webkit/markdown.js'

// Shell components — triggers @customElement for r-shell, r-view, ...
import './shell/r-shell.js'
import './shell/r-view.js'
import './shell/r-chat-panel.js'
import './shell/r-chat-input.js'
import './shell/r-config-form.js'
import './shell/r-agent-select.js'
import './shell/r-surface-error.js'
import './shell/r-welcome-dashboard.js'
import './shell/r-theme-select.js'
import './shell/r-tool-history.js'
import './shell/r-message-bubble.js'
import './shell/r-status-dot.js'

// Shell boot: store init, plugin-host
import { pluginHost } from './shell/plugin-host.js'
import './shell/theme.js'

// Hydrate the in-memory message list from the persisted recent messages
// (stripped of attachment payloads) so the chat panel restores on refresh.
const shellNs = store.namespace<ShellState>('shell')
if (shellNs.get('messages').length === 0 && shellNs.get('lastMessages').length > 0) {
  shellNs.set('messages', shellNs.get('lastMessages'))
}

// Start the plugin-host (seeds config/observe views, starts mode
// watcher, dynamic-imports plugin UI modules).
pluginHost().init()
console.log('Plugin host initialized, shell is ready.')

// The application is now bootstrapped by the <r-shell> component.
// It handles authentication fetching, session initialization,
// and WebSocket connection management.

// watch-test edit
