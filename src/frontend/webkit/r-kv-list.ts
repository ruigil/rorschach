import { html, css } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { RorschachBase } from './base.js'

// Generic key-value list primitive. Renders a list of key-value rows.
// Used by the workflow inspector for specs, pending jobs, and output values.
// Accepts clean, decoupled data — no workflow-specific types.

export type KVItem = {
  key: string
  value: string
};

@customElement('r-kv-list')
export class RKvList extends RorschachBase {
  @property({ type: Array }) items: KVItem[] = []
  @property({ type: String }) emptyText = 'none'

  static override styles = css`
    :host { display: block; }
    .kv-list { display: flex; flex-direction: column; gap: 2px; }
    .kv-row { display: flex; gap: 0.5rem; align-items: baseline; }
    .kv-key { color: var(--text-dim, #3d6878); font-size: 0.75rem; min-width: 80px; }
    .kv-value { color: var(--text-mid, #8abccc); font-size: 0.75rem; flex: 1; }
  `

  override render() {
    if (!this.items.length) {
      return html`<span class="kv-empty">${this.emptyText}</span>`
    }
    return html`
      <div class="kv-list">
        ${this.items.map(item => html`
          <div class="kv-row">
            <span class="kv-key">${item.key}</span>
            <span class="kv-value">${item.value}</span>
          </div>
        `)}
      </div>
    `
  }
}
