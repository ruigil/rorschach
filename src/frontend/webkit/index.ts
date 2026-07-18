// ─── WebUI-Kit barrel export ───
//
// Re-exports all kit primitives so the shell's `rorschach.ts` can import them
// with a single `import '@rorschach/webkit/index.js'` to trigger every
// `@customElement` decorator. Plugins import individual primitives from their
// specific module paths (e.g. `@rorschach/webkit/r-badge.js`) so the
// build's `splitting: true` can tree-shake unused primitives from plugin
// bundles.

export * from './base.js'
export * from './host-types.js'
export * from './r-icon.js'
export * from './r-badge.js'
export * from './r-empty-state.js'
export * from './r-tabs.js'
export * from './r-button.js'
export * from './r-card.js'
export * from './r-panel.js'
export * from './r-tree.js'
export * from './r-flash-message.js'
export * from './r-media-previews.js'
export * from './r-audio-player.js'
export * from './r-log-stream.js'
export * from './r-force-graph.js'
export * from './r-list.js'
export * from './r-calendar.js'
export * from './r-split-pane.js'
export * from './r-toolbar.js'
export * from './r-select.js'
export * from './r-section-header.js'
export * from './r-kv-list.js'
export * from './r-toggle.js'
export * from './r-input.js'
export * from './r-search-select.js'
export * from './r-corona.js'
export * from './shared-styles.js'
export * from './runtime/store.js'
export * from './runtime/store-controller.js'
export * from './markdown.js'
export * from './r-markdown.js'
export * from './runtime/connection-service.js'
