import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase, ICONS } from './base.js';

@customElement('r-icon')
export class RIcon extends RorschachBase {
  @property({ type: String }) name: keyof typeof ICONS | '' = '';
  @property({ type: String }) size: 'sm' | 'md' | 'lg' | 'xl' | '' = 'md';

  static override styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: inherit;
      line-height: 0;
    }
    :host([size="sm"]) { width: 10px; height: 10px; }
    :host([size="md"]) { width: 15px; height: 15px; }
    :host([size="lg"]) { width: 28px; height: 28px; }
    :host([size="xl"]) { width: 48px; height: 48px; }
    :host(:not([size])) { width: 15px; height: 15px; }
    svg { width: 100%; height: 100%; }
  `;

  override render() {
    return this.renderIcon(this.name as keyof typeof ICONS);
  }
}
