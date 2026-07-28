// ─── Core Plugin IDs ─────────────────────────────────────────────────────────
//
// Plugin ids that must never be unloaded at runtime: without them the system
// cannot serve HTTP/WS traffic or configuration/admin APIs.
//
// This module is intentionally dependency-free so it can be shared by the
// backend (config-set.ts) and the frontend bundle (r-config-panel) without
// pulling the actor system into browser code.
//
export const CORE_PLUGIN_IDS: readonly string[] = ['interfaces', 'config']
