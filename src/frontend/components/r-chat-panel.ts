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
    return this; // Light DOM for standard styles
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('chat-submit', this._handleSubmit);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('chat-submit', this._handleSubmit);
  }

  override updated(changedProperties: Map<string | symbol, unknown>) {
    super.updated(changedProperties);

    const messages = this._messages.value as any[];
    const activeStream = this._activeStream.value as any;

    const messagesChanged = messages.length !== this._lastMessagesLength;
    const streamActiveChanged = activeStream.isActive !== this._lastStreamActive;
    const streamTextChanged = activeStream.text !== this._lastStreamText;

    if (messagesChanged || streamActiveChanged || streamTextChanged) {
      this._scrollToBottom();
      
      this._lastMessagesLength = messages.length;
      this._lastStreamActive = activeStream.isActive;
      this._lastStreamText = activeStream.text;

      // Trigger a pulse animation on message receive/send when floating
      const win = (store.get('windows') as any)?.chat;
      if (win && !win.isDocked && (messagesChanged || streamActiveChanged)) {
        this.classList.add('message-pulse');
        setTimeout(() => this.classList.remove('message-pulse'), 800);
      }
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

  private _handleSubmit(event: any) {
    const { text, attachments } = event.detail;
    submitChatMessage(text, attachments);
  }

  override render() {
    const messages = this._messages.value as any[];
    const activeStream = this._activeStream.value as any;

    const win = (store.get('windows') as any)?.chat;
    const isUndocked = win ? !win.isDocked : false;
    const viewClass = isUndocked ? 'window-view' : 'panel-view';

    return html`
      <div class="chat-main ${viewClass}">
        <div class="chat-window-content">
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
        </div>

        <div class="chat-window-footer">
          <div class="chat-dock">
            <r-chat-input></r-chat-input>
          </div>
        </div>
      </div>
    `;
  }
}
