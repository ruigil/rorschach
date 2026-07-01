import { html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { RorschachBase } from '@rorschach/frontend/webkit/base.js';
import { StoreController } from '@rorschach/frontend/webkit/store-controller.js';
import { setTheme, getTheme } from './theme.js';

@customElement('r-theme-select')
export class RThemeSelect extends RorschachBase {
  private _theme = new StoreController(this, ['shell', 'theme']);

  // Light DOM — styled by the same global shell.css rules
  override createRenderRoot() {
    return this;
  }

  private _toggleTheme() {
    const current = this._theme.value ?? getTheme();
    const next = current === 'light' ? 'eclipse' : 'light';
    setTheme(next);
  }

  override render() {
    const current = this._theme.value ?? getTheme();
    const isLight = current === 'light';
    
    return html`
      <button
        id="theme-toggle"
        class="theme-toggle-btn"
        title=${isLight ? 'Switch to dark theme' : 'Switch to light theme'}
        aria-label=${isLight ? 'Switch to dark theme' : 'Switch to light theme'}
        @click=${this._toggleTheme}
      >
        <r-icon name=${isLight ? 'moon' : 'sun'}></r-icon>
      </button>
    `;
  }
}
