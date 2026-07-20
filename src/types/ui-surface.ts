import type { FrameType } from './events.ts'

// ─── Plugin UI surface registration ───
//
// Plugins contribute browser-side UI surfaces (windows + their backing module)
// to the shell without importing it. Mirrors the RouteRegistrationTopic pattern:
// a plugin publishes a registration on `start` and tombstones on `stopped`; the
// HTTP plugin bridges the retained topic to a `ui.surface` WS frame; the
// shell's plugin-host reacts by dynamic-importing the module, registering the
// window, and routing claimed WS frame types to the surface's reducer.
//
// `id` identifies the surface so it can be revoked (publish the same id with
// moduleUrl: null on plugin stop). One retained topic keyed by `id` keeps the
// window config, the module URL, and the frame-type claim atomic — they share
// a lifecycle with the plugin.

export type UiSurfaceViewConfig = {
  title: string
  icon: string
  contentTag: string
  /** Auto-open this view when one of these modes activates. */
  modes?: string[]
};

export type UiSurfaceRegistration =
  | {
      id: string
      version: string
      view?: UiSurfaceViewConfig
      /** URL the shell dynamic-imports to load this surface's module. */
      moduleUrl: string
      /** WS frame types this surface claims. The dispatcher routes them to the
       *  surface's reducer instead of the shell's handlers. */
      frameTypes?: FrameType[]
    }
  | { id: string; view?: null; moduleUrl: null; frameTypes?: null }
