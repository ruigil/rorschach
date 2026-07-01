import { html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { RorschachBase } from '@rorschach/frontend/webkit/base.js';
import { StoreController } from '@rorschach/frontend/webkit/store-controller.js';
import { setTheme, getTheme, availableThemes } from './theme.js';
import type { ThemeName } from './theme.js';

@customElement('r-theme-select')
export class RThemeSelect extends RorschachBase {
  private _theme = new StoreController(this, ['shell', 'theme']);

  // Light DOM — styled by the same global shell.css rules as r-mode-select
  // so the two header dropdowns share a single visual language.
  override createRenderRoot() {
    return this;
  }

  private _handleChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    setTheme(select.value as ThemeName);
  }

  override render() {
    const current = this._theme.value ?? getTheme();
    return html`
      <label class="header-select-wrap" for="theme-select">
        <span>theme</span>
        <select id="theme-select" class="header-select" .value=${current} @change=${this._handleChange}>
          ${availableThemes().map(name => html`
            <option value=${name} ?selected=${name === current}>
              ${name.charAt(0).toUpperCase() + name.slice(1)}
            </option>
          `)}
        </select>
      </label>
    `;
  }
}
