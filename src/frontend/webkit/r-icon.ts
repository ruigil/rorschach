import {
  css,
  customElement,
  html,
  property,
  RorschachBase,
  unsafeHTML
} from './base.js';

import { ICONS, type IconName } from './icons.js';

@customElement('r-icon')
export class RIcon extends RorschachBase {
  @property({ type: String }) name?: IconName;
  @property({ type: String, reflect: true }) size?: 'sm' | 'md' | 'lg' | 'xl';

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

  override willUpdate(changedProperties: Map<string | symbol, unknown>) {
    const nameChanged = changedProperties.has('name');
    const sizeChanged = changedProperties.has('size');

    if (!this.size) {
      this.size = this.name ? this.getDefaultSize(this.name) : 'md';
    } else if (nameChanged && !sizeChanged) {
      this.size = this.name ? this.getDefaultSize(this.name) : 'md';
    }
  }

  private getDefaultSize(name: IconName): 'sm' | 'md' | 'lg' | 'xl' {
    if (name === 'chevron-down' || name === 'chevron-right' || name === 'file') return 'sm';
    if (['monitor', 'eye', 'activity', 'terminal', 'network', 'waterfall'].includes(name)) return 'lg';
    if (name === 'signal') return 'xl';
    return 'md';
  }

  override render() {
    if (!this.name) return html``;
    const svg = ICONS[this.name];
    if (!svg) return html``;
    return html`${unsafeHTML(svg)}`;
  }
}
