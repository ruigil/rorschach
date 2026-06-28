import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase } from './base.js';

@customElement('r-card')
export class RCard extends RorschachBase {
  @property({ type: Boolean, reflect: true }) hoverable = false;

  static override styles = css`
    :host {
      display: block;
      background: var(--surface, #060e14);
      border: 1px solid var(--border, #0d1f2d);
      border-radius: var(--radius, 8px);
      overflow: hidden;
      transition: all 0.15s ease-in-out;
    }

    :host([hoverable]) {
      cursor: pointer;
    }

    :host([hoverable]:hover) {
      border-color: var(--border-mid, #1a3548);
      background: var(--surface-2, #0a1820);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }

    .card-header {
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border, #0d1f2d);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .card-body {
      padding: 1rem;
    }

    .card-footer {
      padding: 0.75rem 1rem;
      border-top: 1px solid var(--border, #0d1f2d);
      background: rgba(0, 0, 0, 0.15);
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
        <div class="card-footer">
          <slot name="footer"></slot>
        </div>
      </slot>
    `;
  }
}
