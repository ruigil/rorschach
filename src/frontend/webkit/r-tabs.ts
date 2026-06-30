import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase } from './base.js';

@customElement('r-tabs')
export class RTabs extends RorschachBase {
  @property({ type: String, reflect: true }) variant: 'default' | 'flat' = 'default';

  static override styles = css`
    :host {
      display: flex;
      gap: 10px;
      align-items: stretch;
      padding: 0 1rem;
      border-bottom: 1px solid var(--border, #0d1f2d);
      background: transparent;
      min-height: 38px;
    }

    ::slotted(button) {
      font-family: var(--font-ui, sans-serif);
      font-size: 0.64rem;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--text-dim, #3d6878);
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      padding: 0 1rem;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      transition: color 0.15s, border-color 0.15s;
      position: relative;
      top: 1px;
      outline: none;
    }

    ::slotted(button:first-of-type) {
      padding-left: 0;
    }

    ::slotted(button:hover) {
      color: var(--text-mid, #8abccc);
    }

    ::slotted(button.active), ::slotted(button[active]) {
      color: var(--accent, #00c4d4);
      border-bottom-color: var(--accent, #00c4d4);
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('click', this._handleClick);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('click', this._handleClick);
  }

  private _handleClick(e: MouseEvent) {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    const tabId = btn.dataset.tab || btn.dataset.subtab || btn.dataset.configTab;
    if (!tabId) return;

    this.dispatchEvent(new CustomEvent('tab-change', {
      bubbles: true,
      composed: true,
      detail: { tab: tabId },
    }));
  }

  override render() {
    return html`<slot></slot>`;
  }
}
