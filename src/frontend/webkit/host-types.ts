// ─── Plugin → shell host contract ───
//
// Neutral types that live in the frontend/webkit so plugins can import the *type*
// only, never the shell's implementation. Mirrors the backend's
// `ActorContext` pattern: a narrow, dependency-injected facade. The shell's
// `plugin-host` module supplies the implementation; plugins declare
// `host: PluginHostActions` on their `reduceFrame` and call `host.openView`
// to open their view when a frame arrives.

export type PluginHostActions = {
  openView(id: string): void
  closeView(id: string): void
  setMode(mode: string): void
};

// View configuration the shell reads when rendering an `r-view`. Same
// shape as ViewConfig plus `id` (added by pluginHost when it seeds
// the runtime registry). Plugins publish the `UiSurfaceViewConfig` shape
// (no `id`) via UiSurfaceRegistrationTopic; the host adds `id` from the
// registration's `id` field.
export type ViewConfig = {
  id: string
  title: string
  icon: string
  contentTag: string
  modes?: string[]
};

// Runtime state for a view — owned by the shell namespace
// (`store.namespace('shell')['views'][id]`). Plugins do not read it; the
// `PluginHostActions` facade deliberately exposes no view-state accessor.
export type ViewRuntimeState = {
  id: string
  isOpen: boolean
  params: Record<string, any>
};

