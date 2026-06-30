import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase } from './base.js';

export type RToggleChangeEvent = CustomEvent<{ checked: boolean }>;

@customElement('r-toggle')
export class RToggle extends RorschachBase {
  @property({ type: Boolean }) checked = false;
  @property({ type: Boolean, reflect: true }) disabled = false;
  @property({ type: String }) label = '';
  @property({ type: String }) hint = '';

  static override styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      font-family: var(--font-ui, sans-serif);
    }
    .label-group {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
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
    .switch {
      position: relative;
      width: 36px;
      height: 20px;
      flex-shrink: 0;
    }
    .switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .track {
      position: absolute;
      inset: 0;
      background: var(--muted);
      border-radius: 100px;
      cursor: pointer;
      transition: background 0.2s, box-shadow 0.2s;
    }
    .track::after {
      content: '';
      position: absolute;
      width: 14px;
      height: 14px;
      left: 3px;
      top: 3px;
      background: var(--text-mid);
      border-radius: 50%;
      transition: transform 0.2s, background 0.2s;
    }
    .switch input:checked + .track {
      background: var(--accent);
      box-shadow: 0 0 8px var(--accent-glow);
    }
    .switch input:checked + .track::after {
      transform: translateX(16px);
      background: var(--bg);
    }
    .switch input:disabled + .track {
      opacity: 0.5;
      cursor: default;
    }
  `;

  private _onChange(e: Event) {
    const input = e.target as HTMLInputElement;
    this.checked = input.checked;
    this.dispatchEvent(new CustomEvent('change', {
      bubbles: true,
      composed: true,
      detail: { checked: this.checked },
    }) as RToggleChangeEvent);
  }

  override render() {
    return html`
      <div class="label-group">
        ${this.label ? html`<span class="label">${this.label}</span>` : ''}
        ${this.hint ? html`<span class="hint">${this.hint}</span>` : ''}
      </div>
      <label class="switch">
        <input type="checkbox" .checked=${this.checked} ?disabled=${this.disabled} @change=${this._onChange} />
        <span class="track"></span>
      </label>
    `;
  }
}
