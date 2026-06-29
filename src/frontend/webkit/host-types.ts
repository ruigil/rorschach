// ─── Plugin → shell host contract ───
//
// Neutral types that live in the frontend/webkit so plugins can import the *type*
// only, never the shell's implementation. Mirrors the backend's
// `ActorContext` pattern: a narrow, dependency-injected facade. The shell's
// `plugin-host` module supplies the implementation; plugins declare
// `host: PluginHostActions` on their `reduceFrame` and call `host.openWindow`
// to open their window when a frame arrives.

export type PluginHostActions = {
  openWindow(id: string): void
  closeWindow(id: string): void
  setMode(mode: string): void
};

// Window configuration the shell reads when rendering an `r-window`. Same
// shape as today's WindowConfig plus `id` (added by pluginHost when it seeds
// the runtime registry). Plugins publish the `UiSurfaceWindowConfig` shape
// (no `id`) via UiSurfaceRegistrationTopic; the host adds `id` from the
// registration's `id` field.
export type WindowConfig = {
  id: string
  title: string
  icon: string
  contentTag: string
  dockResizable?: boolean
  defaultWidth: number
  defaultHeight: number
  minWidth: number
  minHeight: number
  modes?: string[]
};

// Runtime state for a window — owned by the shell namespace
// (`store.namespace('shell')['windows'][id]`). Plugins do not read it; the
// `PluginHostActions` facade deliberately exposes no window-state accessor.
export type WindowRuntimeState = {
  id: string
  isOpen: boolean
  isMinimized: boolean
  x: number
  y: number
  w: number
  h: number
  zIndex: number
  params: Record<string, any>
};
