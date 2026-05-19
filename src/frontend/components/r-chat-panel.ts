import { html } from 'lit';
import { customElement, query } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { store, StoreController } from '../store.js';

@customElement('r-chat-panel')
export class RChatPanel extends RorschachBase {
  private _isConnected = new StoreController(this, 'isConnected');
  private _isWaiting = new StoreController(this, 'isWaiting');
  private _messages = new StoreController(this, 'messages');
  private _activeStream = new StoreController(this, 'activeStream');

  @query('#messages') private messagesEl!: HTMLElement;

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('chat-submit', this._handleSubmit);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('chat-submit', this._handleSubmit);
  }

  override updated(changedProperties: Map<string, any>) {
    if (changedProperties.has('_messages') || changedProperties.has('_activeStream')) {
      this._scrollToBottom();
    }
  }

  private _scrollToBottom() {
    requestAnimationFrame(() => {
      if (this.messagesEl) {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      }
    });
  }

  override focus() {
    const input = this.querySelector('r-chat-input') as any;
    input?.focus();
  }

  override render() {
    const messages = this._messages.value;
    const activeStream = this._activeStream.value;

    return html`
      <div class="chat-main">
        <div id="messages">
          ${messages.length === 0 && !activeStream.isActive ? html`
            <r-empty-state id="empty" variant="chat" name="signal" text="Signal detected" subtext="awaiting transmission"></r-empty-state>
          ` : ''}
          
          ${messages.map(m => html`<r-message-bubble .message=${m}></r-message-bubble>`)}
          
          ${activeStream.isActive ? html`
            <r-message-bubble .stream=${activeStream} type="assistant"></r-message-bubble>
          ` : ''}
        </div>
        <div class="chat-dock">
          <r-chat-input></r-chat-input>
        </div>
      </div>
    `;
  }

  private _handleSubmit(event: any) {
    const { text, attachments } = event.detail;
    const ws = store.get('ws');
    if ((!text && attachments.length === 0) || ws?.readyState !== WebSocket.OPEN || this._isWaiting.value) return;

    store.appendMessage({
      id: crypto.randomUUID(),
      role: 'user',
      text,
      attachments,
      timestamp: Date.now()
    });

    ws.send(JSON.stringify({ text, attachments }));
    store.set('isWaiting', true);
    store.updateActiveStream({ isActive: true });

    const logoMark = document.querySelector('.logo-mark');
    logoMark?.classList.add('noticing');
    setTimeout(() => logoMark?.classList.remove('noticing'), 700);
  }
}
