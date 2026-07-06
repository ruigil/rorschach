import {
  css,
  customElement,
  html,
  property,
  RorschachBase,
  state
} from './base.js';

@customElement('r-card')
export class RCard extends RorschachBase {
  @property({ type: Boolean, reflect: true }) hoverable = false;
  @state() private _hasFooter = false;

  private _onFooterSlotChange(e: Event) {
    const slot = e.target as HTMLSlotElement;
    this._hasFooter = slot.assignedNodes().length > 0;
  }

  static override styles = css`
    :host {
      display: block;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius, 8px);
      overflow: hidden;
      transition: all 0.15s ease-in-out;
    }

    :host([hoverable]) {
      cursor: pointer;
    }

    :host([hoverable]:hover) {
      border-color: var(--border-mid);
      background: var(--surface-2, #0a1820);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }

    .card-header {
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .card-body {
      padding: 1rem;
    }

    .card-footer {
      padding: 0.75rem 1rem;
      border-top: 1px solid var(--border);
      background: var(--card-footer-bg);
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 0.5rem;
    }
  `;

  override render() {
    return html`
      <slot name="header-container">
        <div class="card-header">
          <slot name="header"></slot>
          <slot name="header-actions"></slot>
        </div>
      </slot>
      <div class="card-body">
        <slot></slot>
      </div>
      <slot name="footer-container">
        ${this._hasFooter ? html`
          <div class="card-footer">
            <slot name="footer" @slotchange=${this._onFooterSlotChange}></slot>
          </div>
        ` : html`
          <slot name="footer" @slotchange=${this._onFooterSlotChange} style="display: none;"></slot>
        `}
      </slot>
    `;
  }
}
