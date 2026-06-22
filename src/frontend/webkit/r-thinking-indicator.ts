import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase } from './base.js';

@customElement('r-thinking-indicator')
export class RThinkingIndicator extends RorschachBase {
  @property({ type: String }) label = '';

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 0.4rem;
      padding: 0.4rem 0;
    }

    .tool-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.62rem;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--accent);
      font-style: italic;
      opacity: 0.85;
      margin-bottom: 0.4rem;
      padding: 0.18rem 0.55rem;
      background: rgba(0, 196, 212, 0.07);
      border: 1px solid rgba(0, 196, 212, 0.18);
      border-radius: 6px;
    }

    .tool-badge::before {
      content: '⚙';
      font-style: normal;
      font-size: 0.65rem;
      opacity: 0.7;
      animation: streamPulse 1.4s ease-in-out infinite;
    }

    .dots-row {
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .dot {
      width: 4px; height: 4px;
      border-radius: 50%;
      background: var(--text-dim);
      animation: voidPulse 1.8s ease-in-out infinite;
    }

    .dot:nth-child(2) { animation-delay: 0.3s; background: var(--accent); }
    .dot:nth-child(3) { animation-delay: 0.6s; }

    @keyframes voidPulse {
      0%, 100% { opacity: 0.1; transform: scale(0.7); }
      50%       { opacity: 0.9; transform: scale(1.3); }
    }

    @keyframes streamPulse {
      0%, 100% { opacity: 0.3; }
      50%       { opacity: 1.0; }
    }
  `;

  override render() {
    return html`
      ${this.label ? html`<div class="tool-badge">${this.label}</div>` : ''}
      <div class="dots-row">
        <div class="dot"></div>
        <div class="dot"></div>
        <div class="dot"></div>
      </div>
    `;
  }

  /**
   * For backward compatibility with imperative code
   */
  show(toolLabel = '', extraClass = '') {
    this.label = toolLabel;
    if (extraClass) this.className = extraClass;
  }
}
