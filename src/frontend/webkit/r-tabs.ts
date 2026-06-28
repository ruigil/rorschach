import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { RorschachBase } from './base.js';

@customElement('r-tabs')
export class RTabs extends RorschachBase {
  static override styles = css`
    :host {
      display: flex;
      gap: 2px;
      border-bottom: 1px solid var(--border, #0d1f2d);
      background: transparent;
    }

    ::slotted(button) {
      background: transparent;
      border: 1px solid transparent;
      border-bottom: none;
      color: var(--text-dim, #3d6878);
      padding: 6px 12px;
      font-family: var(--font-ui, sans-serif);
      font-size: 0.72rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease-in-out;
      border-top-left-radius: 4px;
      border-top-right-radius: 4px;
      margin-bottom: -1px;
      outline: none;
    }

    ::slotted(button:hover) {
      color: var(--text-mid, #8abccc);
      background: rgba(0, 196, 212, 0.02);
    }

    ::slotted(button.active), ::slotted(button[active]) {
      color: var(--accent, #00c4d4);
      border-color: var(--border, #0d1f2d);
      background: var(--surface, #060e14);
      font-weight: 600;
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
