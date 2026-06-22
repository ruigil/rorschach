import { html, css } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { RorschachBase } from './base.js'

// Generic list primitive with optional status chips. Renders a list of
// items, each with a main label, meta text, and optional chips (e.g. run
// status chips). Dispatches `item-select` and `chip-select` CustomEvents.
// Used by the workflow list view. Accepts clean, decoupled data — no
// workflow-specific types.

export interface ListItemChip {
  id: string
  label: string
  status?: string
}

export interface ListItem {
  id: string
  label: string
  meta?: string
  chips?: ListItemChip[]
}

@customElement('r-list')
export class RList extends RorschachBase {
  @property({ type: Array }) items: ListItem[] = []
  @property({ type: String }) emptyText = 'no items'

  static override styles = css`
    :host { display: block; }
    .list { display: flex; flex-direction: column; gap: 4px; }
    .list-item { display: flex; flex-direction: column; gap: 4px; }
    .list-main-btn {
      display: flex; flex-direction: column; gap: 2px;
      text-align: left; padding: 8px 10px; cursor: pointer;
      background: var(--surface-2, #0a1820); border: 1px solid var(--border, #0d1f2d);
      border-radius: 4px; color: var(--text, #e8f6fa); font-family: var(--font-ui, sans-serif);
      font-size: 0.82rem; transition: border-color 0.15s, background 0.15s;
    }
    .list-main-btn:hover { border-color: var(--border-mid, #1a3548); background: var(--surface, #060e14); }
    .list-label { font-weight: 500; }
    .list-meta { color: var(--text-dim, #3d6878); font-size: 0.72rem; }
    .chip-list { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 2px; }
    .chip {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 8px; border-radius: 12px; font-size: 0.68rem;
      cursor: pointer; border: 1px solid var(--border, #0d1f2d);
      background: var(--surface-2, #0a1820); color: var(--text-mid, #8abccc);
      font-family: var(--font-mono, monospace);
    }
    .chip:hover { border-color: var(--border-mid, #1a3548); }
    .chip.status-running { border-color: var(--accent, #00c4d4); color: var(--accent, #00c4d4); }
    .chip.status-completed { border-color: var(--green, #39e8a0); color: var(--green, #39e8a0); }
    .chip.status-failed { border-color: var(--error, #e06030); color: var(--error, #e06030); }
    .chip.status-blocked { border-color: var(--warn, #c4843a); color: var(--warn, #c4843a); }
    .list-empty { color: var(--text-dim, #3d6878); font-size: 0.8rem; padding: 1rem; text-align: center; }
  `

  override render() {
    if (!this.items.length) {
      return html`<div class="list-empty">${this.emptyText}</div>`
    }
    return html`
      <div class="list">
        ${this.items.map(item => html`
          <div class="list-item">
            <button class="list-main-btn" type="button" @click=${() => this._selectItem(item.id)}>
              <span class="list-label">${item.label}</span>
              ${item.meta ? html`<span class="list-meta">${item.meta}</span>` : ''}
            </button>
            ${item.chips?.length ? html`
              <div class="chip-list">
                ${item.chips.map(chip => html`
                  <button
                    class="chip status-${chip.status ?? 'idle'}"
                    type="button"
                    @click=${(e: Event) => { e.stopPropagation(); this._selectChip(item.id, chip.id) }}
                  >
                    <span>${chip.status ?? chip.label}</span>
                    <span>${chip.label}</span>
                  </button>
                `)}
              </div>
            ` : ''}
          </div>
        `)}
      </div>
    `
  }

  private _selectItem(id: string) {
    this.dispatchEvent(new CustomEvent('item-select', { detail: { id }, bubbles: true, composed: true }))
  }

  private _selectChip(itemId: string, chipId: string) {
    this.dispatchEvent(new CustomEvent('chip-select', { detail: { itemId, chipId }, bubbles: true, composed: true }))
  }
}
