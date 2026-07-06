import {
  css,
  customElement,
  html,
  nothing,
  property,
  RorschachBase,
  state
} from './base.js';

export type RSearchSelectOption = {
  value: string;
  label: string;
  sublabel?: string;
};

export type RSearchSelectChangeEvent = CustomEvent<{ value: string }>;

@customElement('r-search-select')
export class RSearchSelect extends RorschachBase {
  @property({ type: String }) value = '';
  @property({ type: Array }) options: RSearchSelectOption[] = [];
  @property({ type: String }) label = '';
  @property({ type: String }) hint = '';
  @property({ type: String }) name = '';
  @property({ type: String }) placeholder = 'Select...';
  @property({ type: Boolean, reflect: true }) disabled = false;

  @state() private _open = false;
  @state() private _query = '';
  private _onOutsideClick = (e: MouseEvent) => {
    if (!this.contains(e.target as Node)) this._open = false;
  };

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
      font-family: var(--font-ui, sans-serif);
      width: 100%;
      max-width: 600px;
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
    .container {
      position: relative;
      width: 100%;
    }
    .input {
      width: 100%;
      padding: 0.65rem 0.9rem;
      background: var(--surface-2);
      border: 1px solid var(--border-mid);
      border-radius: var(--radius);
      color: var(--text);
      font-family: var(--font-mono, monospace);
      font-size: 0.82rem;
      font-weight: 400;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
      cursor: text;
    }
    .input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-dim);
    }
    .input::placeholder {
      color: var(--muted);
    }
    .input:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .dropdown {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      max-height: 250px;
      overflow-y: auto;
      background: var(--surface);
      border: 1px solid var(--border-mid);
      border-radius: var(--radius);
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
      z-index: 100;
      scrollbar-width: thin;
      scrollbar-color: var(--border-mid) transparent;
    }
    .dropdown::-webkit-scrollbar { width: 4px; }
    .dropdown::-webkit-scrollbar-track { background: transparent; }
    .dropdown::-webkit-scrollbar-thumb { background: var(--border-mid); border-radius: 2px; }
    .dropdown::-webkit-scrollbar-thumb:hover { background: var(--muted); }
    .item {
      padding: 0.55rem 0.8rem;
      font-size: 0.78rem;
      font-family: var(--font-ui, sans-serif);
      color: var(--text-mid);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      transition: background 0.15s, color 0.15s;
    }
    .item:hover {
      background: var(--accent-dim);
      color: var(--text);
    }
    .item.selected {
      background: var(--accent-dim);
      color: var(--accent-bright);
      border-left: 2px solid var(--accent);
    }
    .item-name { font-weight: 500; }
    .item-sub {
      font-size: 0.68rem;
      color: var(--muted);
      font-family: var(--font-mono, monospace);
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('click', this._onOutsideClick);
  }

  override disconnectedCallback() {
    window.removeEventListener('click', this._onOutsideClick);
    super.disconnectedCallback();
  }

  private _getSelectedLabel(): string {
    const selected = this.options.find(o => o.value === this.value);
    return selected?.label ?? this.value ?? '';
  }

  private _openDropdown() {
    if (this.disabled) return;
    this._open = true;
    this._query = '';
  }

  private _onQueryInput(e: Event) {
    this._query = (e.target as HTMLInputElement).value;
  }

  private _select(value: string) {
    this.value = value;
    this._open = false;
    this._query = '';
    this.dispatchEvent(new CustomEvent('change', {
      bubbles: true,
      composed: true,
      detail: { value },
    }) as RSearchSelectChangeEvent);
  }

  override render() {
    const displayValue = this._open ? this._query : this._getSelectedLabel();
    const query = this._query.toLowerCase();
    const filtered = this.options.filter(o =>
      o.label.toLowerCase().includes(query) || o.value.toLowerCase().includes(query)
    );

    return html`
      ${this.label ? html`<span class="label">${this.label}</span>` : nothing}
      <div class="container">
        <input
          type="text"
          class="input"
          .value=${displayValue}
          placeholder=${this.placeholder}
          ?disabled=${this.disabled}
          @focus=${this._openDropdown}
          @input=${this._onQueryInput}
        />
        ${this._open ? html`
          <div class="dropdown">
            <div class="item" @click=${() => this._select('')}>
              <span class="item-name">— none —</span>
            </div>
            ${filtered.map(o => html`
              <div
                class="item ${o.value === this.value ? 'selected' : ''}"
                @click=${() => this._select(o.value)}
              >
                <span class="item-name">${o.label}</span>
                ${o.sublabel ? html`<span class="item-sub">${o.sublabel}</span>` : nothing}
              </div>
            `)}
          </div>
        ` : nothing}
      </div>
      ${this.hint ? html`<span class="hint">${this.hint}</span>` : nothing}
    `;
  }
}
