import { html, css } from 'lit';
import type { TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase } from './base.js';

export type KVListItem = {
  key: string;
  label?: string;
  value: any;
  type?: 'text' | 'code' | 'artifact' | 'html';
  artifactHref?: string;
  artifactPath?: string;
};

@customElement('r-kv-list')
export class RKVList extends RorschachBase {
  @property({ type: Array }) items: KVListItem[] = [];
  @property({ type: String }) emptyText = 'none';

  static override styles = css`
    :host {
      display: block;
      font-family: var(--font-ui, sans-serif);
    }
    .kv-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin: 0;
      padding: 0;
    }
    .kv-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .kv-key {
      color: var(--text-dim, #3d6878);
      font-family: var(--font-mono, monospace);
      font-size: 0.62rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .kv-value {
      color: var(--text-mid, #8abccc);
      font-size: 0.78rem;
      line-height: 1.45;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .kv-muted {
      color: var(--text-dim, #3d6878);
      font-family: var(--font-mono, monospace);
      font-size: 0.68rem;
    }
    pre {
      scrollbar-color: var(--border-mid, #1a3548) transparent;
      scrollbar-width: thin;
      max-height: 12rem;
      margin: 0;
      padding: 8px;
      overflow: auto;
      color: var(--text-mid, #8abccc);
      background: rgba(4, 13, 20, 0.58);
      border: 1px solid var(--border, #0d1f2d);
      border-radius: 4px;
      font-family: var(--font-mono, monospace);
      font-size: 0.66rem;
      line-height: 1.42;
      white-space: pre-wrap;
    }
    pre::-webkit-scrollbar {
      width: 3px;
      height: 3px;
    }
    pre::-webkit-scrollbar-track {
      background: transparent;
    }
    pre::-webkit-scrollbar-thumb {
      background: var(--border-mid, #1a3548);
      border-radius: 2px;
    }
    .artifact-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      color: var(--accent, #00c4d4);
      font-family: var(--font-mono, monospace);
      font-size: 0.68rem;
      text-decoration: none;
      transition: color 0.15s;
    }
    .artifact-link:hover {
      color: var(--accent-bright, #22e8f8);
    }
    .artifact-link span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;

  private _renderValue(item: KVListItem) {
    if (item.type === 'artifact' || this._isArtifactRef(item.value)) {
      const path = item.artifactPath || item.value?.path || item.value?.url || '';
      const href = item.artifactHref || item.value?.url || '';
      if (!href) return this._renderJson(item.value);
      return html`
        <a class="artifact-link" href=${href} target="_blank" rel="noopener noreferrer">
          ${this.renderIcon('file-text')}
          <span>${path}</span>
        </a>
      `;
    }
    if (item.type === 'code') {
      if (typeof item.value === 'string') {
        return html`<pre>${item.value}</pre>`;
      }
    }
    if (item.type === 'html' && typeof item.value === 'object' && item.value !== null && ('_$litType$' in item.value || (item.value as any).strings !== undefined)) {
      return item.value;
    }
    if (typeof item.value === 'object' && item.value !== null) {
      return this._renderJson(item.value);
    }
    return html`${String(item.value)}`;
  }

  private _renderJson(value: unknown) {
    return html`<pre>${JSON.stringify(value, null, 2)}</pre>`;
  }

  private _isArtifactRef(value: unknown): boolean {
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      (value as any).type === 'artifact' &&
      (typeof (value as any).path === 'string' || typeof (value as any).url === 'string');
  }

  override render() {
    if (!this.items || this.items.length === 0) {
      return html`<span class="kv-muted">${this.emptyText}</span>`;
    }
    return html`
      <dl class="kv-list">
        ${this.items.map(item => html`
          <div class="kv-item">
            <dt class="kv-key">${item.label || item.key}</dt>
            <dd class="kv-value">${this._renderValue(item)}</dd>
          </div>
        `)}
      </dl>
    `;
  }
}
