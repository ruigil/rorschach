import { html } from 'lit';
import { customElement, query } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { store, StoreController } from '../store.js';
import { submitChatMessage } from '../actions.js';

@customElement('r-chat-panel')
export class RChatPanel extends RorschachBase {
  private _isConnected = new StoreController(this, 'isConnected');
  private _isWaiting = new StoreController(this, 'isWaiting');
  private _messages = new StoreController(this, 'messages');
  private _activeStream = new StoreController(this, 'activeStream');

  private _lastMessagesLength = 0;
  private _lastStreamText = '';
  private _lastStreamActive = false;

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

  override updated() {
    const messages = this._messages.value;
    const activeStream = this._activeStream.value;

    const messagesChanged = messages.length !== this._lastMessagesLength;
    const streamActiveChanged = activeStream.isActive !== this._lastStreamActive;
    const streamTextChanged = activeStream.text !== this._lastStreamText;

    if (messagesChanged || streamActiveChanged || streamTextChanged) {
      this._scrollToBottom();
      
      this._lastMessagesLength = messages.length;
      this._lastStreamActive = activeStream.isActive;
      this._lastStreamText = activeStream.text;
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
          ${messages.length > 0 || activeStream.isActive ? html`<div class="chat-spacer"></div>` : ''}
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
    submitChatMessage(text, attachments);
  }
}
