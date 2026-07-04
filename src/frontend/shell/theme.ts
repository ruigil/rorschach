// ─── Theme controller ───
//
// The shell owns the theme contract: a `ThemeName` union, a small set of
// helpers, and the wiring to the namespaced store. The actual palettes live
// in `tokens.css` as `:root[data-theme="<name>"]` blocks.
// An inline script in `index.html` sets `data-theme` before first
// paint to avoid a flash of the default theme.

import { store } from '@rorschach/webkit';

export type ThemeName = 'eclipse' | 'light'

export const THEME_NAMES: readonly ThemeName[] = ['eclipse', 'light'] as const
const DEFAULT_THEME: ThemeName = 'eclipse'

const isThemeName = (v: unknown): v is ThemeName => {
  return v === 'eclipse' || v === 'light'
}

const applyToDom = (name: ThemeName): void => {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = name
  }
}

// Reactively subscribe to store 'theme' changes to update the DOM.
store.namespace('shell').subscribe('theme', (theme) => {
  if (isThemeName(theme)) {
    applyToDom(theme)
  }
})

/** Switch the active theme. Updates `<html data-theme>`, persists the choice
 *  via the store, and notifies subscribers. */
export const setTheme = (name: ThemeName): void => {
  store.namespace('shell').set('theme', name)
}

/** Read the active theme from the store (the single source of truth).
 *  Falls back to the default if unset. */
export const getTheme = (): ThemeName => {
  const v = store.namespace('shell').get('theme')
  return isThemeName(v) ? v : DEFAULT_THEME
}

export const availableThemes = (): readonly ThemeName[] => {
  return THEME_NAMES
}
