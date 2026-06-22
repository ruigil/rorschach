import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { type IconName } from './icons.js';

@customElement('r-icon')
export class RIcon extends RorschachBase {
  @property({ type: String }) name?: IconName;
  @property({ type: String, reflect: true }) size: 'sm' | 'md' | 'lg' | 'xl' = 'md';

  static override styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: inherit;
      line-height: 0;
      flex-shrink: 0;
    }
    :host([size="sm"]) { width: 10px; height: 10px; }
    :host([size="md"]) { width: 15px; height: 15px; }
    :host([size="lg"]) { width: 28px; height: 28px; }
    :host([size="xl"]) { width: 48px; height: 48px; }
    svg { width: 100%; height: 100%; }
  `;

  override render() {
    return this.name ? this.renderIcon(this.name) : html``;
  }
}
