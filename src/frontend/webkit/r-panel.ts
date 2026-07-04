import {
  css,
  customElement,
  html,
  property,
  RorschachBase,
  state
} from './base.js';

@customElement('r-panel')
export class RPanel extends RorschachBase {
  @property({ type: String, reflect: true }) elevation: '1' | '2' = '1';
  @state() private _hasFooter = false;

  private _onFooterSlotChange(e: Event) {
    const slot = e.target as HTMLSlotElement;
    this._hasFooter = slot.assignedNodes().length > 0;
  }

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 100%;
      border: 1px solid var(--border);
      background: var(--surface);
      overflow: hidden;
    }

    :host([elevation="2"]) {
      background: var(--surface-2, #0a1820);
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.5rem 0.75rem;
      background: rgba(0, 0, 0, 0.2);
      border-bottom: 1px solid var(--border);
      min-height: 38px;
    }

    .panel-content {
      flex: 1;
      overflow: auto;
      position: relative;
      scrollbar-width: thin;
      scrollbar-color: var(--border-mid) transparent;
    }

    .panel-content::-webkit-scrollbar {
      width: 5px;
      height: 5px;
    }

    .panel-content::-webkit-scrollbar-track {
      background: transparent;
    }

    .panel-content::-webkit-scrollbar-thumb {
      background: var(--border-mid);
      border-radius: 3px;
    }

    .panel-content::-webkit-scrollbar-thumb:hover {
      background: var(--accent);
    }

    .panel-footer {
      display: flex;
      align-items: center;
      padding: 0.5rem 0.75rem;
      background: rgba(0, 0, 0, 0.1);
      border-top: 1px solid var(--border);
    }
  `;

  override render() {
    return html`
      <slot name="header-container">
        <div class="panel-header">
          <slot name="header"></slot>
          <slot name="header-actions"></slot>
        </div>
      </slot>
      <div class="panel-content">
        <slot></slot>
      </div>
      <slot name="footer-container">
        ${this._hasFooter ? html`
          <div class="panel-footer">
            <slot name="footer" @slotchange=${this._onFooterSlotChange}></slot>
          </div>
        ` : html`
          <slot name="footer" @slotchange=${this._onFooterSlotChange} style="display: none;"></slot>
        `}
      </slot>
    `;
  }
}
