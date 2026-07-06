import {
  css,
  customElement,
  html,
  nothing,
  property,
  RorschachBase
} from './base.js';

import './r-icon.js';

@customElement('r-select')
export class RSelect extends RorschachBase {
  @property({ type: String }) value = '';
  @property({ type: Array }) options: { value: string; label: string }[] = [];
  @property({ type: Boolean, reflect: true }) disabled = false;
  @property({ type: String }) label = '';
  @property({ type: String }) hint = '';
  @property({ type: String, reflect: true }) variant: 'default' | 'field' = 'default';

  static override styles = css`
    :host {
      display: inline-block;
      width: 100%;
    }
    :host([variant="field"]) {
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
      font-family: var(--font-ui, sans-serif);
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
    :host([variant="field"]) select {
      padding: 0.65rem 32px 0.65rem 0.9rem;
      font-family: var(--font-mono, monospace);
      font-size: 0.82rem;
      font-weight: 400;
      color: var(--text);
      border-color: var(--border-mid);
      border-radius: var(--radius);
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
    :host([variant="field"]) select:focus:not(:disabled) {
      box-shadow: 0 0 0 3px var(--accent-dim);
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
    .label {
      font-size: 0.72rem;
      font-weight: 500;
      color: var(--text-mid);
      letter-spacing: 0.04em;
    }
    .hint {
      font-size: 0.65rem;
      color: var(--text-dim);
      font-family: var(--font-mono, monospace);
      font-weight: 300;
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
      ${this.label ? html`<span class="label">${this.label}</span>` : nothing}
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
          <r-icon name="chevron-down" size="sm"></r-icon>
        </span>
      </div>
      ${this.hint ? html`<span class="hint">${this.hint}</span>` : nothing}
    `;
  }
}
