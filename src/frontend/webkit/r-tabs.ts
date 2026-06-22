import { customElement } from 'lit/decorators.js';
import { RorschachBase } from './base.js';

@customElement('r-tabs')
export class RTabs extends RorschachBase {
  override createRenderRoot() {
    return this;
  }

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
}
