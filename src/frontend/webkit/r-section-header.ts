import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase } from './base.js';

@customElement('r-section-header')
export class RSectionHeader extends RorschachBase {
  @property({ type: String }) override title = '';
  @property({ type: String }) description = '';

  static override styles = css`
    :host {
      display: block;
      margin-bottom: 12px;
      border-bottom: 1px solid var(--border, #0d1f2d);
      padding-bottom: 8px;
    }
    .header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }
    .title-group {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .title {
      font-family: var(--font-ui, sans-serif);
      font-size: 0.72rem;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-mid, #8abccc);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .desc {
      font-size: 0.68rem;
      color: var(--text-dim, #3d6878);
      line-height: 1.3;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
  `;

  override render() {
    return html`
      <div class="header-row">
        <div class="title-group">
          <span class="title">${this.title}</span>
          ${this.description ? html`<span class="desc">${this.description}</span>` : ''}
        </div>
        <div class="actions">
          <slot name="actions"></slot>
          <slot></slot>
        </div>
      </div>
    `;
  }
}
