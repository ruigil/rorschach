import { html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { type Message, type ActiveStream } from './types.js';
import { renderMarkdown } from './markdown.js';
import { StoreController } from './store-controller.js';

interface ShellModeState {
  currentMode: string
}

@customElement('r-message-bubble')
export class RMessageBubble extends RorschachBase {
  @property({ type: Object }) message?: Message;
  @property({ type: Object }) stream?: ActiveStream;
  @property({ type: String, reflect: true }) type: 'assistant' | 'user' | 'error' = 'assistant';

  private _currentMode = new StoreController<ShellModeState, 'currentMode'>(this, ['shell', 'currentMode']);

  // Render to light DOM to reuse chat.css styles
  override createRenderRoot() {
    return this;
  }

  private _getLabelText() {
    const role = this.message?.role ?? this.type;
    if (role === 'user') return 'You';
    if (role === 'error') return 'Error';
    
    const mode = this._currentMode.value;
    const suffix = mode && mode !== 'chatbot' ? ` [${mode.charAt(0).toUpperCase() + mode.slice(1)}]` : '';
    return `Rorschach${suffix}`;
  }

  override render() {
    const role = this.message?.role ?? this.type;
    const isAssistant = role === 'assistant';
    
    const text = this.message?.text ?? this.stream?.text ?? '';
    const reasoning = this.message?.reasoning ?? this.stream?.reasoning ?? '';
    const sources = this.message?.sources ?? this.stream?.sources ?? [];
    const attachments = this.message?.attachments ?? this.stream?.attachments ?? [];
    const toolingLabel = this.stream?.toolingLabel;

    return html`
      <div class="message ${role}">
        <div class="bubble">
          <div class="bubble-header">
            <span class="bubble-avatar">${role === 'user' ? '👤' : role === 'error' ? '⚠️' : '🤖'}</span>
            <span class="bubble-name">${this._getLabelText()}</span>
          </div>
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
            ${this.message ? renderMarkdown(text) : text}
          </div>

          ${sources.length > 0 ? html`
            <r-sources-list .sources=${sources}></r-sources-list>
          ` : ''}
        </div>
      </div>
    `;
  }
}
