import { html } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { store, StoreController } from '../store.js';
import { submitChatMessage } from '../actions.js';

@customElement('r-chat-panel')
export class RChatPanel extends RorschachBase {
  private _isConnected = new StoreController(this, 'isConnected');
  private _isWaiting = new StoreController(this, 'isWaiting');
  private _messages = new StoreController(this, 'messages');
  private _activeStream = new StoreController(this, 'activeStream');

  @state() private _isUndocked = false;
  @state() private _isCollapsed = false;
  @state() private _x = 0;
  @state() private _y = 0;
  @state() private _w = 300;
  @state() private _h = 600;
  @state() private _isDragging = false;

  private _lastMessagesLength = 0;
  private _lastStreamText = '';
  private _lastStreamActive = false;
  private _resizeObserver?: ResizeObserver;

  @query('#messages') private messagesEl!: HTMLElement;

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('chat-submit', this._handleSubmit);

    this._loadState();

    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver((entries) => {
        if (!this._isUndocked || this._isCollapsed) return;
        for (const entry of entries) {
          const width = this.offsetWidth;
          const height = this.offsetHeight;
          if (width === 0 || height === 0) continue;
          if (Math.abs(this._w - width) > 1 || Math.abs(this._h - height) > 1) {
            this._w = width;
            this._h = height;
            this._saveState();
          }
        }
      });
      this._resizeObserver.observe(this);
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('chat-submit', this._handleSubmit);
    this._resizeObserver?.disconnect();
  }

  private _loadState() {
    try {
      const defaultX = window.innerWidth - 320;
      const defaultY = 80;
      const saved = localStorage.getItem('rorschach.chat_window_state');
      if (saved) {
        const parsed = JSON.parse(saved);
        this._isUndocked = !!parsed.isUndocked;
        this._isCollapsed = !!parsed.isCollapsed;
        this._x = typeof parsed.x === 'number' ? parsed.x : defaultX;
        this._y = typeof parsed.y === 'number' ? parsed.y : defaultY;
        this._w = typeof parsed.w === 'number' ? parsed.w : 300;
        this._h = typeof parsed.h === 'number' ? parsed.h : 600;
      } else {
        this._isUndocked = false;
        this._isCollapsed = false;
        this._x = defaultX;
        this._y = defaultY;
        this._w = 300;
        this._h = 600;
      }

      this._x = Math.max(0, Math.min(window.innerWidth - 100, this._x));
      this._y = Math.max(0, Math.min(window.innerHeight - 50, this._y));
    } catch (e) {
      console.error('Failed to load chat window state', e);
    }
  }

  private _saveState() {
    try {
      localStorage.setItem('rorschach.chat_window_state', JSON.stringify({
        isUndocked: this._isUndocked,
        isCollapsed: this._isCollapsed,
        x: this._x,
        y: this._y,
        w: this._w,
        h: this._h
      }));
    } catch (e) {
      console.error('Failed to save chat window state', e);
    }
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
      
      this._lastMessagesLength = messages.length;
      this._lastStreamActive = activeStream.isActive;
      this._lastStreamText = activeStream.text;

      // Trigger a pulse animation on message receive/send when undocked
      if (this._isUndocked && (messagesChanged || streamActiveChanged)) {
        this.classList.add('message-pulse');
        setTimeout(() => this.classList.remove('message-pulse'), 800);
      }
    }

    // Apply layout styles to the host element when it is undocked
    if (this._isUndocked) {
      this.classList.add('undocked');
      this.classList.toggle('collapsed', this._isCollapsed);
      this.classList.toggle('dragging', this._isDragging);
      this.style.position = 'fixed';
      this.style.left = `${this._x}px`;
      this.style.top = `${this._y}px`;
      this.style.width = `${this._w}px`;
      
      if (this._isCollapsed) {
        this.style.height = 'auto';
        this.style.resize = 'none';
      } else {
        this.style.height = `${this._h}px`;
        this.style.resize = 'both';
      }
      this.style.zIndex = '9999';
    } else {
      this.classList.remove('undocked', 'collapsed', 'dragging');
      this.style.position = '';
      this.style.left = '';
      this.style.top = '';
      this.style.width = '';
      this.style.height = '';
      this.style.zIndex = '';
      this.style.resize = '';
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

  private _dragStart = { x: 0, y: 0 };
  private _dragOffset = { x: 0, y: 0 };

  private _handleDragStart(e: PointerEvent) {
    if (!this._isUndocked) return;
    if (e.button !== 0) return; // Only left click
    
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('textarea')) return;

    e.preventDefault();
    this._isDragging = true;
    this._dragStart = { x: e.clientX, y: e.clientY };
    this._dragOffset = { x: this._x, y: this._y };

    const handlePointerMove = (moveEv: PointerEvent) => {
      const dx = moveEv.clientX - this._dragStart.x;
      const dy = moveEv.clientY - this._dragStart.y;
      this._x = Math.max(0, Math.min(window.innerWidth - 100, this._dragOffset.x + dx));
      this._y = Math.max(0, Math.min(window.innerHeight - 50, this._dragOffset.y + dy));
      this._saveState();
    };

    const handlePointerUp = () => {
      this._isDragging = false;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }

  private _toggleCollapse() {
    this._isCollapsed = !this._isCollapsed;
    this._saveState();
  }

  private _toggleDock() {
    this._isUndocked = !this._isUndocked;
    this._saveState();
    store.set('isChatUndocked', this._isUndocked);
  }

  private _handleSubmit(event: any) {
    const { text, attachments } = event.detail;
    submitChatMessage(text, attachments);
  }

  override render() {
    const messages = this._messages.value;
    const activeStream = this._activeStream.value;

    let filteredItems: any[] = [];
    if (this._isUndocked) {
      const lastUserIndex = messages.map(m => m.role === 'user').lastIndexOf(true);
      const lastAssistantIndex = messages.map(m => m.role === 'assistant' || m.role === 'error').lastIndexOf(true);

      const lastUserMsg = lastUserIndex !== -1 ? messages[lastUserIndex] : null;
      const lastAssistantMsg = lastAssistantIndex !== -1 ? messages[lastAssistantIndex] : null;

      if (activeStream.isActive) {
        if (lastUserMsg) {
          filteredItems.push(html`<r-message-bubble .message=${lastUserMsg}></r-message-bubble>`);
        }
        filteredItems.push(html`<r-message-bubble .stream=${activeStream} type="assistant"></r-message-bubble>`);
      } else {
        if (lastUserMsg && lastAssistantMsg) {
          if (lastUserIndex < lastAssistantIndex) {
            filteredItems.push(html`<r-message-bubble .message=${lastUserMsg}></r-message-bubble>`);
            filteredItems.push(html`<r-message-bubble .message=${lastAssistantMsg}></r-message-bubble>`);
          } else {
            filteredItems.push(html`<r-message-bubble .message=${lastAssistantMsg}></r-message-bubble>`);
            filteredItems.push(html`<r-message-bubble .message=${lastUserMsg}></r-message-bubble>`);
          }
        } else if (lastUserMsg) {
          filteredItems.push(html`<r-message-bubble .message=${lastUserMsg}></r-message-bubble>`);
        } else if (lastAssistantMsg) {
          filteredItems.push(html`<r-message-bubble .message=${lastAssistantMsg}></r-message-bubble>`);
        }
      }
    }

    return html`
      <div class="chat-main ${this._isUndocked ? 'window-view' : 'panel-view'}">
        <div class="chat-window-header" @pointerdown=${this._handleDragStart}>
          <div class="chat-window-title">
            ${this._isUndocked ? html`<span class="drag-handle-dots">⋮⋮</span>` : ''}
            <span class="chat-window-status">${this._isUndocked ? 'Mini Chat' : 'Chat'}</span>
          </div>
          <div class="chat-window-controls">
            ${this._isUndocked ? html`
              <button class="control-btn collapse-btn" @click=${this._toggleCollapse} title="${this._isCollapsed ? 'Expand' : 'Collapse'}">
                ${this._isCollapsed ? html`
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                ` : html`
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
                    <polyline points="18 15 12 9 6 15"/>
                  </svg>
                `}
              </button>
            ` : ''}
            <button class="control-btn dock-btn" @click=${this._toggleDock} title="${this._isUndocked ? 'Dock to main panel' : 'Undock to floating window'}">
              ${this._isUndocked ? html`
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <line x1="9" y1="3" x2="9" y2="21"/>
                </svg>
              ` : html`
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                  <polyline points="15 3 21 3 21 9"/>
                  <line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
              `}
            </button>
          </div>
        </div>

        <div class="chat-window-content" ?hidden=${this._isUndocked && this._isCollapsed}>
          <div id="messages">
            ${this._isUndocked ? html`
              ${filteredItems.length === 0 ? html`
                <div class="mini-empty-state">
                  <svg viewBox="0 0 48 48" fill="none" class="empty-icon" width="24" height="24">
                    <circle cx="24" cy="24" r="1.5" fill="currentColor" opacity="0.9"/>
                    <ellipse cx="24" cy="24" rx="7" ry="2.5" stroke="currentColor" stroke-width="0.5" opacity="0.5"/>
                  </svg>
                  <div class="empty-text">Awaiting transmission</div>
                </div>
              ` : filteredItems}
            ` : html`
              ${messages.length > 0 || activeStream.isActive ? html`<div class="chat-spacer"></div>` : ''}
              ${messages.length === 0 && !activeStream.isActive ? html`
                <r-empty-state id="empty" variant="chat" name="signal" text="Signal detected" subtext="awaiting transmission"></r-empty-state>
              ` : ''}
              
              ${messages.map(m => html`<r-message-bubble .message=${m}></r-message-bubble>`)}
              
              ${activeStream.isActive ? html`
                <r-message-bubble .stream=${activeStream} type="assistant"></r-message-bubble>
              ` : ''}
            `}
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
