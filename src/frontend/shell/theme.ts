// ─── Theme controller ───
//
// The shell owns the theme contract: a `ThemeName` union, a small set of
// helpers, and the wiring to the namespaced store. The actual palettes live
// in `tokens.css` as `:root[data-theme="<name>"]` blocks.
// An inline script in `index.html` sets `data-theme` before first
// paint to avoid a flash of the default theme; `initTheme()` is idempotent
// and wires the store so `setTheme()` persists and reactive consumers
// (e.g. `<r-theme-select>`) update.

import { store } from '@rorschach/frontend/webkit/store.js'

export type ThemeName = 'eclipse' | 'light' | 'high-contrast'

export const THEME_NAMES: readonly ThemeName[] = ['eclipse', 'light', 'high-contrast'] as const

const STORAGE_KEY = 'rorschach.store.shell.theme'
const DEFAULT_THEME: ThemeName = 'eclipse'

function isThemeName(v: string | null): v is ThemeName {
  return v === 'eclipse' || v === 'light' || v === 'high-contrast'
}

function readSavedTheme(): ThemeName {
  if (typeof localStorage === 'undefined') return DEFAULT_THEME;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_THEME;
  try {
    const parsed = JSON.parse(raw);
    return isThemeName(parsed) ? parsed : DEFAULT_THEME;
  } catch {
    return isThemeName(raw) ? raw : DEFAULT_THEME;
  }
}

function applyToDom(name: ThemeName): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = name
  }
}

/** Apply the persisted theme (or the default) to the document before first paint. */
export function initTheme(): void {
  const initial = readSavedTheme()
  applyToDom(initial)
}

/** Switch the active theme. Updates `<html data-theme>`, persists the choice
 *  via the store, and notifies subscribers. */
export function setTheme(name: ThemeName): void {
  applyToDom(name)
  store.namespace('shell').set('theme', name)
}

/** Read the active theme from the store (the single source of truth after
 *  `initTheme()` has run). Falls back to the default if unset. */
export function getTheme(): ThemeName {
  const v = store.namespace('shell').get('theme')
  return isThemeName(v as string | null) ? (v as ThemeName) : DEFAULT_THEME
}

export function availableThemes(): readonly ThemeName[] {
  return THEME_NAMES
}
