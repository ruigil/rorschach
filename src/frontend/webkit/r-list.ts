import {
  css,
  customElement,
  html,
  property,
  RorschachBase
} from './base.js';

import { type IconName } from './icons.js';
import './r-icon.js';

export type ListItemChip = {
  id: string;
  label: string;
  status?: string;
};

export type ListItemAction = {
  id: string;
  icon: IconName;
  label?: string;
};

export type ListItem = {
  id: string;
  label: string;
  meta?: string;
  description?: string;
  icon?: IconName;
  status?: string;
  chips?: ListItemChip[];
  actions?: ListItemAction[];
};

@customElement('r-list')
export class RList extends RorschachBase {
  @property({ type: Array }) items: ListItem[] = [];
  @property({ type: String }) emptyText = 'no items';
  @property({ type: Boolean }) selectable = false;
  @property({ type: String }) selectedId: string | null = null;

  @property({ type: String, reflect: true }) variant: 'default' | 'flat' = 'default';

  static override styles = css`
    :host {
      display: block;
      font-family: var(--font-ui, sans-serif);
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .list-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 6px 10px;
      background: var(--surface-2, #0a1820);
      border: 1px solid var(--border);
      border-radius: 4px;
      transition: border-color 0.15s, background 0.15s;
    }
    :host([variant="flat"]) .list-item {
      background: transparent;
      border: none;
      padding: 2px 0;
      border-radius: 0;
    }
    .list-item.selectable {
      cursor: pointer;
    }
    .list-item.selectable:hover {
      border-color: var(--border-mid);
      background: var(--surface);
    }
    .list-item.selected {
      border-color: var(--accent);
      background: rgba(0, 196, 212, 0.04);
    }
    .list-item-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .list-item-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .list-item-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }
    .list-label {
      font-size: 0.82rem;
      font-weight: 500;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .list-meta {
      font-family: var(--font-mono, monospace);
      color: var(--text-dim);
      font-size: 0.68rem;
      white-space: nowrap;
    }
    .list-description {
      color: var(--text-mid);
      font-size: 0.72rem;
      line-height: 1.3;
    }
    .list-item-icon {
      color: var(--text-dim);
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .list-item.selected .list-item-icon {
      color: var(--accent);
    }
    .list-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .action-btn {
      background: transparent;
      border: none;
      color: var(--text-dim);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s, background 0.15s;
    }
    .action-btn:hover {
      background: rgba(255, 255, 255, 0.05);
      color: var(--text);
    }
    .chip-list {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 4px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 0.68rem;
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text-mid);
      font-family: var(--font-mono, monospace);
      transition: border-color 0.15s;
    }
    .chip:hover {
      border-color: var(--border-mid);
    }
    .chip.status-running { border-color: var(--accent); color: var(--accent); }
    .chip.status-completed { border-color: var(--green); color: var(--green); }
    .chip.status-failed { border-color: var(--error); color: var(--error); }
    .chip.status-blocked { border-color: var(--warn); color: var(--warn); }
    .list-empty {
      color: var(--text-dim);
      font-size: 0.8rem;
      padding: 1.5rem;
      text-align: center;
      border: 1px dashed var(--border);
      border-radius: 6px;
    }
  `;

  override render() {
    if (!this.items || this.items.length === 0) {
      return html`<div class="list-empty">${this.emptyText}</div>`;
    }
    return html`
      <div class="list">
        ${this.items.map(item => {
          const isSelected = this.selectedId === item.id;
          return html`
            <div 
              class="list-item ${this.selectable ? 'selectable' : ''} ${isSelected ? 'selected' : ''}"
              @click=${() => this._selectItem(item)}
            >
              <div class="list-item-row">
                ${item.icon 
                  ? html`<span class="list-item-icon"><r-icon name=${item.icon}></r-icon></span>` 
                  : ''}
                
                <div class="list-item-content">
                  <div class="list-item-header">
                    <span class="list-label">${item.label}</span>
                    ${item.meta ? html`<span class="list-meta">${item.meta}</span>` : ''}
                  </div>
                  
                  ${item.description 
                    ? html`<div class="list-description">${item.description}</div>` 
                    : ''}
                </div>

                ${item.actions && item.actions.length > 0 
                  ? html`
                    <div class="list-actions">
                      ${item.actions.map(action => html`
                        <button
                          class="action-btn"
                          type="button"
                          title=${action.label || ''}
                          @click=${(e: Event) => this._onActionClick(e, item.id, action.id)}
                        >
                          <r-icon name=${action.icon}></r-icon>
                        </button>
                      `)}
                    </div>
                  ` 
                  : ''}
              </div>

              ${item.chips && item.chips.length > 0 
                ? html`
                  <div class="chip-list">
                    ${item.chips.map(chip => html`
                      <button
                        class="chip status-${chip.status ?? 'idle'}"
                        type="button"
                        @click=${(e: Event) => this._selectChip(e, item.id, chip.id)}
                      >
                        <span>${chip.status ?? chip.label}</span>
                        <span>${chip.label}</span>
                      </button>
                    `)}
                  </div>
                ` 
                : ''}
            </div>
          `;
        })}
      </div>
    `;
  }

  private _selectItem(item: ListItem) {
    if (!this.selectable) return;
    this.selectedId = item.id;
    this.dispatchEvent(new CustomEvent('item-select', {
      detail: { id: item.id, item },
      bubbles: true,
      composed: true
    }));
  }

  private _selectChip(e: Event, itemId: string, chipId: string) {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent('chip-select', {
      detail: { itemId, chipId },
      bubbles: true,
      composed: true
    }));
  }

  private _onActionClick(e: Event, itemId: string, actionId: string) {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent('action-click', {
      detail: { itemId, actionId },
      bubbles: true,
      composed: true
    }));
  }
}
