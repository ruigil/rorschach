import {
  customElement,
  html,
  query,
  RorschachBase,
  state,
  store,
  StoreController
} from '@rorschach/webkit';

import { submitChatMessage, cancelChatMessage } from './actions.js';

@customElement('r-chat-panel')
export class RChatPanel extends RorschachBase {
  private _isConnected = new StoreController(this, ['shell', 'isConnected']);
  private _isWaiting = new StoreController(this, ['shell', 'isWaiting']);
  private _messages = new StoreController(this, ['shell', 'messages']);
  private _activeStream = new StoreController(this, ['shell', 'activeStream']);

  private _lastMessagesLength = 0;
  private _lastStreamText = '';
  private _lastStreamActive = false;

  @query('#messages') private messagesEl!: HTMLElement;
  @query('r-chat-input') private chatInputEl!: any;

  /** Incremented to request focus on the chat input via reactive property. */
  @state() private _focusSignal = 0;

  override createRenderRoot() {
    return this; // Light DOM for standard styles
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('chat-submit', this._handleSubmit);
    this.addEventListener('chat-cancel', this._handleCancel);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('chat-submit', this._handleSubmit);
    this.removeEventListener('chat-cancel', this._handleCancel);
  }

  override updated(changedProperties: Map<string | symbol, unknown>) {
    super.updated(changedProperties);

    const messages = this._messages.value;
    const activeStream = this._activeStream.value;

    const messagesChanged = messages.length !== this._lastMessagesLength;
    const streamActiveChanged = activeStream.isActive !== this._lastStreamActive;
    const streamTextChanged = activeStream.text !== this._lastStreamText;

    if (messagesChanged || streamActiveChanged || streamTextChanged) {
      this._scrollToBottom();

      if (this._lastStreamActive && !activeStream.isActive) {
        setTimeout(() => { this._focusSignal++ }, 100);
      }

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

  private _handleSubmit(event: any) {
    const { text, attachments } = event.detail;
    submitChatMessage(text, attachments);
  }

  private _handleCancel() {
    cancelChatMessage();
  }

  override render() {
    const messages = this._messages.value;
    const activeStream = this._activeStream.value;

    const viewClass = 'panel-view';

    return html`
      <div class="chat-main ${viewClass}">
        <div class="chat-sidebar-content">
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

        <div class="chat-sidebar-footer">
          <div class="chat-input-container">
            <r-chat-input .focusSignal=${this._focusSignal}></r-chat-input>
          </div>
        </div>
      </div>
    `;
  }
}
