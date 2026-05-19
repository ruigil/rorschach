import { LightElement, defineElement } from './base.js'
import { store } from '../store.js'
import { renderMarkdown } from '../markdown.js'

function toolActionLabel(toolName) {
  if (toolName === 'web_search') return 'searching the web...'
  if (toolName === 'analyze_image') return 'analysing image...'
  return `running ${toolName}...`
}

export class RChatPanel extends LightElement {
  constructor() {
    super()
    this._thinkingEl = null
    this._streamWrap = null
    this._streamBubbleContainer = null
    this._streamBubble = null
    this._streamRawText = ''
    this._reasoningEl = null
    this._pendingSources = null
    this._pendingAttachments = null
    this._unsubConnected = null
    this._onFrame = (event) => this.handleFrame(event.detail)
    this._onSubmit = (event) => this._handleSubmit(event)
  }

  connectedCallback() {
    this._render()
    this.addEventListener('chat-submit', this._onSubmit)
    document.addEventListener('ws-message', this._onFrame)
    this._unsubConnected = store.subscribe('isConnected', (connected) => {
      if (!connected) {
        this.removeThinking()
        this.resetStream()
      }
    })
  }

  disconnectedCallback() {
    this.removeEventListener('chat-submit', this._onSubmit)
    document.removeEventListener('ws-message', this._onFrame)
    this._unsubConnected?.()
    this._unsubConnected = null
  }

  get messagesEl() {
    return this.$('#messages')
  }

  get emptyEl() {
    return this.$('#empty')
  }

  get chatInput() {
    return this.$('r-chat-input')
  }

  focus() {
    this.chatInput?.focus()
  }

  resetStream() {
    this._streamWrap = null
    this._streamBubbleContainer = null
    this._streamBubble = null
    this._streamRawText = ''
    this._reasoningEl = null
    this._pendingSources = null
    this._pendingAttachments = null
  }

  removeThinking() {
    this._thinkingEl?.remove()
    this._thinkingEl = null
  }

  handleFrame(msg) {
    if (msg.type === 'tooling') {
      this.removeThinking()
      const tools = msg.tools ?? []
      const label = tools.length === 1
        ? toolActionLabel(tools[0])
        : tools.length > 1 ? `invoking ${tools.length} tools...` : 'working...'
      this._showThinking(label, 'searching')
    } else if (msg.type === 'sources') {
      this._pendingSources = msg.sources
    } else if (msg.type === 'attachments') {
      this._handleAttachments(msg.attachments)
    } else if (msg.type === 'reasoningChunk') {
      this._appendReasoning(msg.text)
    } else if (msg.type === 'chunk') {
      this._appendChunk(msg.text)
    } else if (msg.type === 'done') {
      this._finishStream()
    } else if (msg.type === 'error') {
      this._showError(msg.text)
    }
  }

  _render() {
    this.innerHTML = `
      <div class="chat-main">
        <div id="messages">
          <r-empty-state id="empty" variant="chat" name="signal" text="Signal detected" subtext="awaiting transmission"></r-empty-state>
        </div>
        <div class="chat-dock">
          <r-chat-input></r-chat-input>
        </div>
      </div>
    `
  }

  _scrollToBottom() {
    const messagesEl = this.messagesEl
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight
  }

  _ensureStreamWrap() {
    if (!this._streamWrap) {
      const bubble = document.createElement('r-message-bubble')
      bubble.type = 'assistant'
      this._streamWrap = bubble
      this._streamBubbleContainer = bubble.bubbleContainer
      this.messagesEl?.appendChild(this._streamWrap)
    }
  }

  _showThinking(toolLabel = '', extraClass = '') {
    this.emptyEl?.remove()
    this._ensureStreamWrap()
    const indicator = document.createElement('r-thinking-indicator')
    indicator.show(toolLabel, extraClass)
    this._streamBubbleContainer.appendChild(indicator)
    this._scrollToBottom()
    this._thinkingEl = indicator
  }

  _appendUserMessage(text, attachments = []) {
    this.emptyEl?.remove()
    const bubble = document.createElement('r-message-bubble')
    bubble.type = 'user'

    const images = attachments.filter(a => a.kind === 'image')
    if (images.length > 0) bubble.addImages(images)

    const audio = attachments.find(a => a.kind === 'audio')
    if (audio) bubble.addAudio(audio.data)

    const pdfs = attachments.filter(a => a.kind === 'pdf')
    if (pdfs.length > 0) bubble.addPdfs(pdfs)

    if (text) bubble.addText(text)

    this.messagesEl?.appendChild(bubble)
    this._scrollToBottom()
  }

  _handleAttachments(attachments) {
    if (this._streamBubbleContainer) {
      const wrap = document.createElement('r-attachments')
      wrap.render(attachments)
      if (this._streamBubble) this._streamBubbleContainer.insertBefore(wrap, this._streamBubble)
      else this._streamBubbleContainer.appendChild(wrap)
    } else {
      this._pendingAttachments = attachments
    }
  }

  _appendReasoning(text) {
    this.removeThinking()
    this._ensureStreamWrap()
    if (!this._reasoningEl) {
      this._reasoningEl = this._streamWrap.addReasoningSection()
    }
    this._reasoningEl.textContent += text
    this._scrollToBottom()
  }

  _appendChunk(text) {
    if (!this._streamBubble) {
      this.removeThinking()
      this.messagesEl?.classList.add('receiving')
      setTimeout(() => this.messagesEl?.classList.remove('receiving'), 700)
      this._ensureStreamWrap()
      this._reasoningEl = null
      const bodyEl = document.createElement('div')
      bodyEl.className = 'bubble-body'

      if (this._pendingSources) {
        const sourcesList = document.createElement('r-sources-list')
        sourcesList.render(this._pendingSources)
        this._streamBubbleContainer.appendChild(sourcesList)
        this._pendingSources = null
      }

      if (this._pendingAttachments) {
        const attachmentsEl = document.createElement('r-attachments')
        attachmentsEl.render(this._pendingAttachments)
        this._streamBubbleContainer.appendChild(attachmentsEl)
        this._pendingAttachments = null
      }

      this._streamBubbleContainer.appendChild(bodyEl)
      this._streamBubble = bodyEl
      this._streamRawText = ''
    }

    this._streamRawText += text
    this._streamBubble.textContent = this._streamRawText
    this._scrollToBottom()
  }

  _finishStream() {
    if (this._streamBubble && this._streamRawText) {
      this._streamBubble.textContent = ''
      this._streamBubble.appendChild(renderMarkdown(this._streamRawText))
    }

    if (this._pendingAttachments) {
      this._ensureStreamWrap()
      const attachmentsEl = document.createElement('r-attachments')
      attachmentsEl.render(this._pendingAttachments)
      this._streamBubbleContainer.appendChild(attachmentsEl)
      this._pendingAttachments = null
    }

    this.resetStream()
    store.set('isWaiting', false)
    if (document.querySelector('[data-tab="chat"].active')) this.focus()
  }

  _showError(text) {
    this.removeThinking()
    this.resetStream()
    const bubble = document.createElement('r-message-bubble')
    bubble.type = 'error'
    const textEl = document.createElement('div')
    textEl.className = 'bubble-body'
    textEl.textContent = text
    bubble.bubbleContainer.appendChild(textEl)
    this.messagesEl?.appendChild(bubble)
    this._scrollToBottom()
    store.set('isWaiting', false)
    if (document.querySelector('[data-tab="chat"].active')) this.focus()
  }

  _handleSubmit(event) {
    const { text, attachments } = event.detail
    const ws = store.get('ws')
    if ((!text && attachments.length === 0) || ws?.readyState !== WebSocket.OPEN || store.get('isWaiting')) return

    this._appendUserMessage(text, attachments)
    ws.send(JSON.stringify({ text, attachments }))
    store.set('isWaiting', true)
    this._showThinking()

    const logoMark = document.querySelector('.logo-mark')
    logoMark?.classList.add('noticing')
    setTimeout(() => logoMark?.classList.remove('noticing'), 700)
  }
}

defineElement('r-chat-panel', RChatPanel)
