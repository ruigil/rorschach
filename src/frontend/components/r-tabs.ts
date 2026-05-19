import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { RorschachBase } from './base.js';

@customElement('r-tabs')
export class RTabs extends RorschachBase {
  static override styles = css`
    :host {
      display: flex;
      align-items: stretch;
    }

    ::slotted(button) {
      font-size: 0.64rem;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--text-dim, #3d6878);
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      padding: 0 1rem;
      cursor: pointer;
      font-family: var(--font-ui, sans-serif);
      transition: color 0.15s, border-color 0.15s;
      position: relative;
      top: 1px;
    }

    ::slotted(button:hover) {
      color: var(--text-mid, #8abccc);
    }

    ::slotted(button.active) {
      color: var(--accent, #00c4d4);
      border-bottom-color: var(--accent, #00c4d4);
    }
  `;

  private _handleClick(e: MouseEvent) {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    const tabId = btn.dataset.tab || btn.dataset.subtab || btn.dataset.configTab;
    if (!tabId) return;

    // The logic to toggle .active class is still manual because the buttons are in the Light DOM (slotted)
    const allBtns = this.querySelectorAll('button');
    allBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    this.dispatchEvent(new CustomEvent('tab-change', {
      bubbles: true,
      composed: true,
      detail: { tab: tabId },
    }));
  }

  override render() {
    return html`<slot @click=${this._handleClick}></slot>`;
  }
}
