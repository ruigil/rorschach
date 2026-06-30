import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { RorschachBase } from './base.js';

@customElement('r-toolbar')
export class RToolbar extends RorschachBase {
  static override styles = css`
    :host {
      display: flex;
      align-items: stretch;
      justify-content: space-between;
      height: 42px;
      border-bottom: 1px solid var(--border, #0d1f2d);
      background: rgba(7, 21, 32, 0.55);
      flex-shrink: 0;
      box-sizing: border-box;
      width: 100%;
    }

    ::slotted(r-tabs) {
      padding: 0 !important;
    }
  `;

  override render() {
    return html`
      <div style="display: flex; align-items: stretch; flex: 1; min-width: 0; padding-left: 1.25rem;">
        <slot></slot>
      </div>
      <div style="display: flex; align-items: center; gap: 1.25rem; flex-shrink: 0; padding-right: 1.25rem;">
        <slot name="actions"></slot>
      </div>
    `;
  }
}
