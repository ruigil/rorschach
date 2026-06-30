// ─── WebUI-Kit barrel export ───
//
// Re-exports all kit primitives so the shell's `rorschach.ts` can import them
// with a single `import '@rorschach/frontend/webkit/index.js'` to trigger every
// `@customElement` decorator. Plugins import individual primitives from their
// specific module paths (e.g. `@rorschach/frontend/webkit/r-badge.js`) so the
// build's `splitting: true` can tree-shake unused primitives from plugin
// bundles.

export * from './base.js'
export * from './host-types.js'
export * from './r-icon.js'
export * from './r-badge.js'
export * from './r-status-dot.js'
export * from './r-empty-state.js'
export * from './r-tabs.js'
export * from './r-button.js'
export * from './r-card.js'
export * from './r-panel.js'
export * from './r-tree.js'
export * from './r-flash-message.js'
export * from './r-thinking-indicator.js'
export * from './r-attachments.js'
export * from './r-sources-list.js'
export * from './r-media-previews.js'
export * from './r-message-bubble.js'
export * from './r-topic-list.js'
export * from './r-actor-tree.js'
export * from './r-actor-detail.js'
export * from './r-log-stream.js'
export * from './r-tools-list.js'
export * from './r-costs-table.js'
export * from './r-trace-waterfall.js'
export * from './r-force-graph.js'
export * from './r-list.js'
export * from './r-calendar.js'
export * from './r-split-pane.js'
export * from './r-toolbar.js'

