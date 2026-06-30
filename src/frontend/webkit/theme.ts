// ─── Theme controller ───
//
// The kit owns the theme contract: a `ThemeName` union, a small set of
// helpers, and the wiring to the namespaced store. The actual palettes live
// in `tokens.css` as `:root[data-theme="<name>"]` blocks; this module only
// flips the `data-theme` attribute on `<html>` and persists the choice.
//
// CSS custom properties inherit through shadow-DOM boundaries, so every
// primitive restyles instantly when `data-theme` changes — no per-component
// wiring. An inline script in `index.html` sets `data-theme` before first
// paint to avoid a flash of the default theme; `initTheme()` is idempotent
// and wires the store so `setTheme()` persists and reactive consumers
// (e.g. `<r-theme-select>`) update.

import { store } from './store.js'

export type ThemeName = 'eclipse' | 'light' | 'high-contrast'

export const THEME_NAMES: readonly ThemeName[] = ['eclipse', 'light', 'high-contrast'] as const

const STORAGE_KEY = 'rorschach.store.shell.theme'
const DEFAULT_THEME: ThemeName = 'eclipse'

function isThemeName(v: string | null): v is ThemeName {
  return v === 'eclipse' || v === 'light' || v === 'high-contrast'
}

function readSavedTheme(): ThemeName {
  if (typeof localStorage === 'undefined') return DEFAULT_THEME
  const raw = localStorage.getItem(STORAGE_KEY)
  return isThemeName(raw) ? raw : DEFAULT_THEME
}

function applyToDom(name: ThemeName): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = name
  }
}

/** Seed the store with the persisted theme (or the default) and apply it to
 *  the document. Idempotent — safe to call multiple times. Call once during
 *  shell bootstrap, before any component that subscribes to `theme` mounts. */
export function initTheme(): void {
  const initial = readSavedTheme()
  applyToDom(initial)
  store.namespace<{ theme: ThemeName }>('shell').init({ theme: initial }, { persist: ['theme'] })
}

/** Switch the active theme. Updates `<html data-theme>`, persists the choice
 *  via the store, and notifies subscribers. */
export function setTheme(name: ThemeName): void {
  applyToDom(name)
  store.namespace<{ theme: ThemeName }>('shell').set('theme', name)
}

/** Read the active theme from the store (the single source of truth after
 *  `initTheme()` has run). Falls back to the default if unset. */
export function getTheme(): ThemeName {
  const v = store.namespace<{ theme: ThemeName }>('shell').get('theme')
  return isThemeName(v as string | null) ? (v as ThemeName) : DEFAULT_THEME
}

export function availableThemes(): readonly ThemeName[] {
  return THEME_NAMES
}
