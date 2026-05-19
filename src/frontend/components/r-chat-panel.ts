import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { store } from '../store.js';
import { renderMarkdown } from '../markdown.js';
import type { WSFrame } from '../types/websocket.js';

function toolActionLabel(toolName: string) {
  if (toolName === 'web_search') return 'searching the web...';
  if (toolName === 'analyze_image') return 'analysing image...';
  return `running ${toolName}...`;
}

@customElement('r-chat-panel')
export class RChatPanel extends RorschachBase {
  private _thinkingEl: any = null;
  private _streamWrap: any = null;
  private _streamBubbleContainer: HTMLElement | null = null;
  private _streamBubble: HTMLElement | null = null;
  private _streamRawText = '';
  private _reasoningEl: HTMLElement | null = null;
  private _pendingSources: any = null;
  private _pendingAttachments: any = null;
  private _unsubConnected: (() => void) | null = null;

  private _onFrame = (event: any) => this.handleFrame(event.detail);
  private _onSubmit = (event: any) => this._handleSubmit(event);

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('chat-submit', this._onSubmit);
    document.addEventListener('ws-message', this._onFrame);
    this._unsubConnected = store.subscribe('isConnected', (connected) => {
      if (!connected) {
        this.removeThinking();
        this.resetStream();
      }
    });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('chat-submit', this._onSubmit);
    document.removeEventListener('ws-message', this._onFrame);
    this._unsubConnected?.();
    this._unsubConnected = null;
  }

  get messagesEl() {
    return this.querySelector('#messages');
  }

  get emptyEl() {
    return this.querySelector('#empty');
  }

  get chatInput(): any {
    return this.querySelector('r-chat-input');
  }

  override focus() {
    this.chatInput?.focus();
  }

  resetStream() {
    this._streamWrap = null;
    this._streamBubbleContainer = null;
    this._streamBubble = null;
    this._streamRawText = '';
    this._reasoningEl = null;
    this._pendingSources = null;
    this._pendingAttachments = null;
  }

  removeThinking() {
    this._thinkingEl?.remove();
    this._thinkingEl = null;
  }

  handleFrame(msg: WSFrame) {
    if (msg.type === 'tooling') {
      this.removeThinking();
      const tools = msg.tools ?? [];
      const label = tools.length === 1
        ? toolActionLabel(tools[0])
        : tools.length > 1 ? `invoking ${tools.length} tools...` : 'working...';
      this._showThinking(label, 'searching');
    } else if (msg.type === 'sources') {
      this._pendingSources = msg.sources;
    } else if (msg.type === 'attachments') {
      this._handleAttachments(msg.attachments);
    } else if (msg.type === 'reasoningChunk') {
      this._appendReasoning(msg.text);
    } else if (msg.type === 'chunk') {
      this._appendChunk(msg.text);
    } else if (msg.type === 'done') {
      this._finishStream();
    } else if (msg.type === 'error') {
      this._showError(msg.text);
    }
  }

  override render() {
    return html`
      <div class="chat-main">
        <div id="messages">
          <r-empty-state id="empty" variant="chat" name="signal" text="Signal detected" subtext="awaiting transmission"></r-empty-state>
        </div>
        <div class="chat-dock">
          <r-chat-input></r-chat-input>
        </div>
      </div>
    `;
  }

  private _scrollToBottom() {
    const messagesEl = this.messagesEl;
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  private _ensureStreamWrap() {
    if (!this._streamWrap) {
      const bubble = document.createElement('r-message-bubble') as any;
      bubble.type = 'assistant';
      this._streamWrap = bubble;
      this._streamBubbleContainer = bubble.bubbleContainer;
      this.messagesEl?.appendChild(this._streamWrap);
    }
  }

  private _showThinking(toolLabel = '', extraClass = '') {
    this.emptyEl?.remove();
    this._ensureStreamWrap();
    const indicator = document.createElement('r-thinking-indicator') as any;
    indicator.show(toolLabel, extraClass);
    this._streamBubbleContainer?.appendChild(indicator);
    this._scrollToBottom();
    this._thinkingEl = indicator;
  }

  private _appendUserMessage(text: string, attachments: any[] = []) {
    this.emptyEl?.remove();
    const bubble = document.createElement('r-message-bubble') as any;
    bubble.type = 'user';

    const images = attachments.filter(a => a.kind === 'image');
    if (images.length > 0) bubble.addImages(images);

    const audio = attachments.find(a => a.kind === 'audio');
    if (audio) bubble.addAudio(audio.data);

    const pdfs = attachments.filter(a => a.kind === 'pdf');
    if (pdfs.length > 0) bubble.addPdfs(pdfs);

    if (text) bubble.addText(text);

    this.messagesEl?.appendChild(bubble);
    this._scrollToBottom();
  }

  private _handleAttachments(attachments: any) {
    if (this._streamBubbleContainer) {
      const wrap = document.createElement('r-attachments') as any;
      wrap.renderLegacy(attachments);
      if (this._streamBubble) this._streamBubbleContainer.insertBefore(wrap, this._streamBubble);
      else this._streamBubbleContainer.appendChild(wrap);
    } else {
      this._pendingAttachments = attachments;
    }
  }

  private _appendReasoning(text: string) {
    this.removeThinking();
    this._ensureStreamWrap();
    if (!this._reasoningEl) {
      this._reasoningEl = this._streamWrap.addReasoningSection();
    }
    if (this._reasoningEl) this._reasoningEl.textContent += text;
    this._scrollToBottom();
  }

  private _appendChunk(text: string) {
    if (!this._streamBubble) {
      this.removeThinking();
      this.messagesEl?.classList.add('receiving');
      setTimeout(() => this.messagesEl?.classList.remove('receiving'), 700);
      this._ensureStreamWrap();
      this._reasoningEl = null;
      const bodyEl = document.createElement('div');
      bodyEl.className = 'bubble-body';

      if (this._pendingSources) {
        const sourcesList = document.createElement('r-sources-list') as any;
        sourcesList.renderLegacy(this._pendingSources);
        this._streamBubbleContainer?.appendChild(sourcesList);
        this._pendingSources = null;
      }

      if (this._pendingAttachments) {
        const attachmentsEl = document.createElement('r-attachments') as any;
        attachmentsEl.renderLegacy(this._pendingAttachments);
        this._streamBubbleContainer?.appendChild(attachmentsEl);
        this._pendingAttachments = null;
      }

      this._streamBubbleContainer?.appendChild(bodyEl);
      this._streamBubble = bodyEl;
      this._streamRawText = '';
    }

    this._streamRawText += text;
    if (this._streamBubble) this._streamBubble.textContent = this._streamRawText;
    this._scrollToBottom();
  }

  private _finishStream() {
    if (this._streamBubble && this._streamRawText) {
      this._streamBubble.textContent = '';
      this._streamBubble.appendChild(renderMarkdown(this._streamRawText));
    }

    if (this._pendingAttachments) {
      this._ensureStreamWrap();
      const attachmentsEl = document.createElement('r-attachments') as any;
      attachmentsEl.renderLegacy(this._pendingAttachments);
      this._streamBubbleContainer?.appendChild(attachmentsEl);
      this._pendingAttachments = null;
    }

    this.resetStream();
    store.set('isWaiting', false);
    if (document.querySelector('[data-tab="chat"].active')) this.focus();
  }

  private _showError(text: string) {
    this.removeThinking();
    this.resetStream();
    const bubble = document.createElement('r-message-bubble') as any;
    bubble.type = 'error';
    const textEl = document.createElement('div');
    textEl.className = 'bubble-body';
    textEl.textContent = text;
    bubble.bubbleContainer?.appendChild(textEl);
    this.messagesEl?.appendChild(bubble);
    this._scrollToBottom();
    store.set('isWaiting', false);
    if (document.querySelector('[data-tab="chat"].active')) this.focus();
  }

  private _handleSubmit(event: any) {
    const { text, attachments } = event.detail;
    const ws = store.get('ws');
    if ((!text && attachments.length === 0) || ws?.readyState !== WebSocket.OPEN || store.get('isWaiting')) return;

    this._appendUserMessage(text, attachments);
    ws.send(JSON.stringify({ text, attachments }));
    store.set('isWaiting', true);
    this._showThinking();

    const logoMark = document.querySelector('.logo-mark');
    logoMark?.classList.add('noticing');
    setTimeout(() => logoMark?.classList.remove('noticing'), 700);
  }
}
