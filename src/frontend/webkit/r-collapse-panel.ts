import {
  css,
  customElement,
  html,
  nothing,
  property,
  RorschachBase,
} from './base.js';
import { sharedStyles } from './shared-styles.js';

import './r-icon.js';
import './r-badge.js';
import { type IconName } from './icons.js';

@customElement('r-collapse-panel')
export class RCollapsePanel extends RorschachBase {
  @property({ type: String }) override title = '';
  @property({ type: String }) icon?: IconName;
  @property({ type: Boolean, reflect: true }) open = true;
  @property({ type: String }) badge?: string;
  @property({ type: String }) status?: string;

  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        margin-bottom: 0.35rem;
        border: 1px solid var(--border);
        border-radius: var(--radius, 6px);
        background: var(--surface);
        overflow: hidden;
      }

      .collapse-header {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.25rem 0.6rem;
        min-height: 28px;
        box-sizing: border-box;
        background: var(--surface-2, var(--panel-header-bg));
        cursor: pointer;
        user-select: none;
        transition: background 0.15s ease;
      }

      .collapse-header:hover {
        background: var(--hover-bg, var(--accent-dim));
      }

      .collapse-chevron {
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-dim);
        transition: transform 0.2s ease;
      }

      .collapse-icon {
        display: inline-flex;
        align-items: center;
        color: var(--accent);
      }

      .collapse-title {
        font-family: var(--font-ui);
        font-size: 0.72rem;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--text);
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .collapse-badge {
        font-family: var(--font-mono, monospace);
        font-size: 0.65rem;
        color: var(--text-dim);
        background: var(--surface);
        padding: 1px 6px;
        border-radius: 8px;
        border: 1px solid var(--border);
      }

      .collapse-body {
        border-top: 1px solid var(--border);
        padding: 0.4rem 0.6rem;
        box-sizing: border-box;
      }

      :host(:not([open])) .collapse-body {
        display: none;
      }
    `
  ];

  private _toggle() {
    this.open = !this.open;
    this.dispatchEvent(new CustomEvent('toggle', {
      bubbles: true,
      composed: true,
      detail: { open: this.open }
    }));
  }

  override render() {
    return html`
      <div class="collapse-header" @click=${this._toggle}>
        <span class="collapse-chevron">
          <r-icon name=${this.open ? 'chevron-down' : 'chevron-right'} size="sm"></r-icon>
        </span>
        ${this.icon ? html`<span class="collapse-icon"><r-icon name=${this.icon} size="sm"></r-icon></span>` : nothing}
        <span class="collapse-title">${this.title}</span>
        ${this.status ? html`<r-badge status=${this.status}>${this.status}</r-badge>` : nothing}
        ${this.badge ? html`<span class="collapse-badge">${this.badge}</span>` : nothing}
        <slot name="header-actions" @click=${(e: Event) => e.stopPropagation()}></slot>
      </div>
      <div class="collapse-body">
        <slot></slot>
      </div>
    `;
  }
}
