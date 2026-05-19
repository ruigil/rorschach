import { LitElement, html } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { ICONS, type IconName } from '../core/icons.js';

export { escHtml, tsStr } from '../core/utils.js';
export { ICONS, type IconName };

export class RorschachBase extends LitElement {
  protected renderIcon(name: IconName) {
    const svg = ICONS[name];
    if (!svg) return html``;
    return html`${unsafeHTML(svg)}`;
  }
}

