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



