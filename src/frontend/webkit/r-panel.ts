import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase } from './base.js';

@customElement('r-panel')
export class RPanel extends RorschachBase {
  @property({ type: String, reflect: true }) elevation: '1' | '2' = '1';

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 100%;
      border: 1px solid var(--border, #0d1f2d);
      background: var(--surface, #060e14);
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
      border-bottom: 1px solid var(--border, #0d1f2d);
      min-height: 38px;
    }

    .panel-content {
      flex: 1;
      overflow: auto;
      position: relative;
      scrollbar-width: thin;
      scrollbar-color: var(--border-mid, rgba(255, 255, 255, 0.15)) transparent;
    }

    .panel-content::-webkit-scrollbar {
      width: 5px;
      height: 5px;
    }

    .panel-content::-webkit-scrollbar-track {
      background: transparent;
    }

    .panel-content::-webkit-scrollbar-thumb {
      background: var(--border-mid, rgba(255, 255, 255, 0.15));
      border-radius: 3px;
    }

    .panel-content::-webkit-scrollbar-thumb:hover {
      background: var(--accent, #00c4d4);
    }

    .panel-footer {
      display: flex;
      align-items: center;
      padding: 0.5rem 0.75rem;
      background: rgba(0, 0, 0, 0.1);
      border-top: 1px solid var(--border, #0d1f2d);
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
        <div class="panel-footer">
          <slot name="footer"></slot>
        </div>
      </slot>
    `;
  }
}
