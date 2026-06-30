import { html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import type { Source } from './types.js';

@customElement('r-sources-list')
export class RSourcesList extends RorschachBase {
  @property({ type: Array }) sources: Source[] = [];
  @state() private open = false;

  static override styles = css`
    :host {
      display: block;
      white-space: normal;
    }

    .sources {
      margin-top: 0.75rem;
      margin-bottom: 0.75rem;
      display: flex;
      flex-direction: column;
    }

    .sources-toggle {
      background: none;
      border: none;
      color: var(--accent);
      cursor: pointer;
      font-size: 0.65rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 0;
      display: flex;
      align-items: center;
      gap: 0.3rem;
      opacity: 0.7;
      transition: opacity 0.15s;
    }

    .sources-toggle:hover {
      opacity: 1;
    }

    .sources-toggle .icon {
      display: inline-flex;
      transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .sources-toggle.open .icon {
      transform: rotate(90deg);
    }

    .sources-list {
      display: none;
      flex-direction: column;
      gap: 0.2rem;
      margin-top: 0.35rem;
      padding-left: 0.5rem;
      border-left: 1px solid rgba(0, 196, 212, 0.1);
    }

    .sources-list.open {
      display: flex;
    }

    .source-item {
      display: flex;
      flex-direction: column;
      padding: 0.25rem 0.45rem;
      border-radius: 4px;
      text-decoration: none;
      color: inherit;
      background: rgba(255, 255, 255, 0.03);
      transition: background 0.15s, transform 0.1s;
    }

    .source-item:hover {
      background: rgba(255, 255, 255, 0.06);
      transform: translateX(2px);
    }

    .source-title {
      font-size: 0.75rem;
      color: var(--bot-text);
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .source-snippet {
      font-size: 0.65rem;
      color: var(--text-dim);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-top: 0.05rem;
    }
  `;

  override render() {
    if (!this.sources || this.sources.length === 0) return html``;

    const count = this.sources.length;
    const label = `${count} source${count !== 1 ? 's' : ''}`;

    return html`
      <div class="sources">
        <button class="sources-toggle ${this.open ? 'open' : ''}" @click=${this.toggle}>
          <span class="icon">${this.renderIcon('chevron-right')}</span>
          ${label}
        </button>
        <div class="sources-list ${this.open ? 'open' : ''}">
          ${this.sources.map(s => html`
            <a class="source-item" href="${s.url}" target="_blank" rel="noopener noreferrer">
              <span class="source-title">${s.title || s.url}</span>
              ${s.snippet ? html`<span class="source-snippet">${s.snippet}</span>` : ''}
            </a>
          `)}
        </div>
      </div>
    `;
  }

  private toggle() {
    this.open = !this.open;
  }
}
