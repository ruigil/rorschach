import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase } from './base.js';

@customElement('r-select')
export class RSelect extends RorschachBase {
  @property({ type: String }) value = '';
  @property({ type: Array }) options: { value: string; label: string }[] = [];
  @property({ type: Boolean, reflect: true }) disabled = false;

  static override styles = css`
    :host {
      display: inline-block;
      width: 100%;
    }
    .select-wrapper {
      position: relative;
      width: 100%;
    }
    select {
      width: 100%;
      background: var(--surface-2, #0a1820);
      border: 1px solid var(--border);
      color: var(--text-mid);
      border-radius: var(--radius, 8px);
      padding: 6px 32px 6px 12px;
      font-family: var(--font-ui, sans-serif);
      font-size: 0.8rem;
      font-weight: 500;
      outline: none;
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
      transition: all 0.15s ease-in-out;
    }
    select:hover:not(:disabled) {
      border-color: var(--border-mid);
      color: var(--text);
    }
    select:focus:not(:disabled) {
      border-color: var(--accent);
      color: var(--text);
      box-shadow: 0 0 8px rgba(0, 196, 212, 0.15);
    }
    select:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
    /* Chevron Icon */
    .chevron {
      position: absolute;
      right: 12px;
      top: 50%;
      transform: translateY(-50%);
      pointer-events: none;
      color: var(--text-dim);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s;
    }
    select:hover:not(:disabled) + .chevron {
      color: var(--text-mid);
    }
  `;

  private _onChange(e: Event) {
    const target = e.target as HTMLSelectElement;
    this.value = target.value;
    this.dispatchEvent(new CustomEvent('change', {
      bubbles: true,
      composed: true,
      detail: { value: this.value }
    }));
  }

  override render() {
    return html`
      <div class="select-wrapper">
        <select 
          .value=${this.value} 
          ?disabled=${this.disabled}
          @change=${this._onChange}
        >
          ${this.options.map(opt => html`
            <option value=${opt.value} ?selected=${opt.value === this.value}>
              ${opt.label}
            </option>
          `)}
        </select>
        <span class="chevron">
          ${this.renderIcon('chevron-down')}
        </span>
      </div>
    `;
  }
}
