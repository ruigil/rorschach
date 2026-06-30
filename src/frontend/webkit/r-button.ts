import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { type IconName } from './icons.js';

@customElement('r-button')
export class RButton extends RorschachBase {
  @property({ type: String, reflect: true }) variant: 'primary' | 'secondary' | 'ghost' | 'danger' = 'secondary';
  @property({ type: String, reflect: true }) size: 'sm' | 'md' | 'lg' = 'md';
  @property({ type: Boolean, reflect: true }) disabled = false;
  @property({ type: Boolean, reflect: true }) loading = false;
  @property({ type: String }) icon?: IconName;
  @property({ type: String }) iconAfter?: IconName;

  static override styles = css`
    :host {
      display: inline-flex;
    }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      border: 1px solid transparent;
      border-radius: var(--radius, 8px);
      cursor: pointer;
      font-family: var(--font-ui, sans-serif);
      font-weight: 500;
      transition: all 0.15s ease-in-out;
      text-decoration: none;
      white-space: nowrap;
      height: 100%;
      width: 100%;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
    
    /* Sizes */
    :host([size="sm"]) button {
      padding: 4px 8px;
      font-size: 0.72rem;
      border-radius: 4px;
    }
    :host([size="md"]) button {
      padding: 6px 12px;
      font-size: 0.8rem;
      border-radius: 6px;
    }
    :host([size="lg"]) button {
      padding: 10px 18px;
      font-size: 0.92rem;
      border-radius: 8px;
    }

    /* Primary Variant */
    :host([variant="primary"]) button {
      background: var(--accent);
      color: var(--bg);
      border-color: var(--accent);
    }
    :host([variant="primary"]) button:hover:not(:disabled) {
      background: var(--accent-bright);
      border-color: var(--accent-bright);
      box-shadow: 0 0 8px var(--accent-glow);
    }

    /* Secondary Variant */
    :host([variant="secondary"]) button {
      background: var(--surface-2, #0a1820);
      color: var(--text);
      border-color: var(--border);
    }
    :host([variant="secondary"]) button:hover:not(:disabled) {
      background: var(--surface);
      border-color: var(--border-mid);
    }

    /* Ghost Variant */
    :host([variant="ghost"]) button {
      background: transparent;
      color: var(--text-mid);
      border-color: transparent;
    }
    :host([variant="ghost"]) button:hover:not(:disabled) {
      background: rgba(0, 196, 212, 0.05);
      color: var(--text);
    }

    /* Danger Variant */
    :host([variant="danger"]) button {
      background: var(--error-bg);
      color: var(--error);
      border-color: var(--error-border);
    }
    :host([variant="danger"]) button:hover:not(:disabled) {
      background: rgba(224, 96, 48, 0.15);
      border-color: var(--error);
    }

    .spinner {
      width: 1em;
      height: 1em;
      border: 2px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      100% { transform: rotate(360deg); }
    }
  `;

  override render() {
    return html`
      <button 
        ?disabled=${this.disabled || this.loading}
        type="button"
      >
        ${this.loading 
          ? html`<span class="spinner"></span>`
          : this.icon 
            ? html`<r-icon name=${this.icon} size="sm"></r-icon>` 
            : ''
        }
        <slot></slot>
        ${!this.loading && this.iconAfter 
          ? html`<r-icon name=${this.iconAfter} size="sm"></r-icon>` 
          : ''
        }
      </button>
    `;
  }
}
