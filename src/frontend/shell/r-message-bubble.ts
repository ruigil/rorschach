import {
  css,
  customElement,
  html,
  property,
  RorschachBase
} from '@rorschach/webkit';

import type { Message, ActiveStream } from './types.js';

import './r-thinking-indicator.js';
import './r-attachments.js';
import './r-sources-list.js';

@customElement('r-message-bubble')
export class RMessageBubble extends RorschachBase {
  @property({ type: Object }) message?: Message;
  @property({ type: Object }) stream?: ActiveStream;
  @property({ type: String, reflect: true }) type: 'assistant' | 'user' | 'error' = 'assistant';

  static override styles = css`
    .reasoning {
      margin-bottom: 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      font-size: 0.78rem;
    }

    .reasoning summary {
      padding: 5px 10px;
      cursor: pointer;
      color: var(--text-dim);
      user-select: none;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .reasoning summary::-webkit-details-marker { display: none; }

    .reasoning summary::before {
      content: '▶';
      font-size: 0.55em;
      opacity: 0.6;
      transition: transform 0.15s ease;
    }

    .reasoning[open] summary::before {
      transform: rotate(90deg);
    }

    .reasoning[open] summary {
      border-bottom: 1px solid var(--border);
    }

    .reasoning-content {
      padding: 10px 12px;
      color: var(--text-dim);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 280px;
      overflow-y: auto;
      margin: 0;
      font-family: var(--font-mono);
      font-size: 0.72rem;
      line-height: 1.55;
      opacity: 0.8;
      scrollbar-width: thin;
      scrollbar-color: var(--border-mid) transparent;
    }

    .reasoning-content::-webkit-scrollbar { width: 4px; }
    .reasoning-content::-webkit-scrollbar-track { background: transparent; }
    .reasoning-content::-webkit-scrollbar-thumb { background: var(--border-mid); border-radius: 2px; }
    .reasoning-content::-webkit-scrollbar-thumb:hover { background: var(--muted); }

    @keyframes reasoning-glow {
      0%, 100% { color: var(--text-dim); text-shadow: none; }
      50% { color: var(--accent-bright); text-shadow: 0 0 8px var(--accent-glow); }
    }

    .reasoning-streaming summary {
      color: var(--accent);
      animation: reasoning-glow 1.8s ease-in-out infinite;
    }

    :host {
      display: flex;
      flex-direction: column;
        padding: 0.75rem 0.75rem !important;
        gap: 0.35rem;
        animation: msgIn 0.24s cubic-bezier(0.16, 1, 0.3, 1) both;
      }
      :host([type="user"]),
      :host([type="assistant"]),
      :host([type="error"]) { align-items: center; }

      @keyframes msgIn {
        from { opacity: 0; transform: translateY(8px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      @keyframes terminalScanIn {
        0%   { opacity: 0; transform: translateX(-8px); }
        60%  { opacity: 0.7; transform: translateX(1px); }
        100% { opacity: 1; transform: translateX(0); }
      }

      :host([type="user"]) {
        animation: terminalScanIn 0.3s cubic-bezier(0.16,1,0.3,1) both;
      }

      .bubble {
        /* Default = assistant styling. Applied even when the type attribute
           isn't reflected (Lit doesn't reflect default property values). */
        font-family: var(--font-mono);
        font-size: 0.875rem;
        font-weight: 300;
        line-height: 1.8;
        word-break: break-word;
        width: 100%;
        color: var(--bot-text);
        padding: 0.7rem 1rem;
        background: var(--bot-bg);
        border: 1px solid var(--bot-border);
        border-radius: var(--radius);
        min-height: 32px;
      }

      :host([type="user"]) .bubble {
        color: var(--user-text);
        background: var(--user-bg);
        border: 1px solid var(--user-border);
        padding: 0.6rem 0.9rem;
        font-weight: 400;
        font-size: 0.84rem;
        line-height: 1.75;
        min-height: 0;
      }

      :host([type="error"]) .bubble {
        color: var(--error);
        background: var(--error-bg);
        border: 1px solid var(--error-border);
        padding: 0.7rem 1rem;
        font-size: 0.82rem;
        min-height: 0;
      }

      .bubble-body { width: 100%; }
  `;

  override willUpdate(changedProperties: Map<string | symbol, unknown>) {
    if (changedProperties.has('message') && this.message?.role) {
      this.type = this.message.role as 'assistant' | 'user' | 'error';
    }
  }

  override render() {
    const role = this.message?.role ?? this.type;
    
    const text = this.message?.text ?? this.stream?.text ?? '';
    const reasoning = this.message?.reasoning ?? this.stream?.reasoning ?? '';
    const sources = this.message?.sources ?? this.stream?.sources ?? [];
    const attachments = this.message?.attachments ?? this.stream?.attachments ?? [];
    const toolingLabel = this.stream?.toolingLabel;

    return html`
      <div class="bubble">
        ${reasoning ? html`
          <details class="reasoning ${!this.message && this.stream?.reasoning ? 'reasoning-streaming' : ''}">
            <summary>Thinking...</summary>
            <pre class="reasoning-content">${reasoning}</pre>
          </details>
        ` : ''}

        ${attachments.length > 0 ? html`
          <r-attachments .items=${attachments}></r-attachments>
        ` : ''}

        ${toolingLabel ? html`
          <r-thinking-indicator .label=${toolingLabel}></r-thinking-indicator>
        ` : ''}

        <div class="bubble-body">
          ${this.message ? html`<r-markdown .content=${text}></r-markdown>` : text}
        </div>

        ${sources.length > 0 ? html`
          <r-sources-list .sources=${sources}></r-sources-list>
        ` : ''}
      </div>
    `;
  }
}
