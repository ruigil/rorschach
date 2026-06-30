import { html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase } from './base.js';

export type RInputType = 'text' | 'number' | 'password' | 'textarea';

export type RInputChangeEvent = CustomEvent<{ value: string | number }>;

@customElement('r-input')
export class RInput extends RorschachBase {
  @property({ type: String }) type: RInputType = 'text';
  @property({ type: String }) value: string | number = '';
  @property({ type: String }) label = '';
  @property({ type: String }) hint = '';
  @property({ type: String }) placeholder = '';
  @property({ type: String }) name = '';
  @property({ type: Boolean, reflect: true }) disabled = false;
  @property({ type: Number }) rows = 3;
  @property({ type: Number }) min: number | undefined;
  @property({ type: Number }) max: number | undefined;

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
      font-family: var(--font-ui, sans-serif);
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
    input, textarea {
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
      appearance: none;
      -webkit-appearance: none;
    }
    textarea {
      line-height: 1.6;
      resize: vertical;
      min-height: 90px;
    }
    input:focus, textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-dim);
    }
    input::placeholder, textarea::placeholder {
      color: var(--muted);
      font-weight: 300;
    }
    input:disabled, textarea:disabled {
      opacity: 0.5;
      cursor: default;
    }
  `;

  private _onInput(e: Event) {
    const target = e.target as HTMLInputElement | HTMLTextAreaElement;
    const raw = target.value;
    const value = this.type === 'number' ? Number(raw) : raw;
    this.value = value;
    this.dispatchEvent(new CustomEvent('change', {
      bubbles: true,
      composed: true,
      detail: { value },
    }) as RInputChangeEvent);
  }

  override render() {
    return html`
      ${this.label ? html`<span class="label">${this.label}</span>` : nothing}
      ${this.type === 'textarea'
        ? html`<textarea
            name=${this.name}
            rows=${this.rows}
            .value=${String(this.value ?? '')}
            placeholder=${this.placeholder}
            ?disabled=${this.disabled}
            @input=${this._onInput}
          ></textarea>`
        : html`<input
            type=${this.type}
            name=${this.name}
            .value=${String(this.value ?? '')}
            placeholder=${this.placeholder}
            ?disabled=${this.disabled}
            .min=${this.min}
            .max=${this.max}
            @input=${this._onInput}
          />`}
      ${this.hint ? html`<span class="hint">${this.hint}</span>` : nothing}
    `;
  }
}
