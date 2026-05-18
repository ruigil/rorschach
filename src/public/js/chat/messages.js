import { state } from '../state.js'
import { renderMarkdown } from '../markdown.js'
import { openPlanList, closePlanWorkspace } from './plan-workspace.js'

const messagesEl = document.getElementById('messages')
const emptyEl = document.getElementById('empty')
const modeSelect = document.getElementById('mode-select')

let thinkingEl = null
let streamWrap = null
let streamBubbleContainer = null
let streamBubble = null
let streamRawText = ''
let reasoningEl = null
let pendingSources = null
let sourcesWrap = null
let pendingAttachments = null
let attachmentsWrap = null
let isPlannerMode = false

let chatInput = null

function modeLabel(mode, displayName = '') {
  if (displayName) return displayName
  if (!mode) return 'Mode'
  return mode.charAt(0).toUpperCase() + mode.slice(1)
}

function syncModeSelect() {
  if (!modeSelect) return
  const selectedMode = state.currentMode
  modeSelect.innerHTML = ''

  const agents = state.agents.length > 0
    ? state.agents
    : selectedMode ? [{ mode: selectedMode, displayName: state.currentModeDisplayName || modeLabel(selectedMode), shortDesc: '' }] : []

  if (agents.length === 0) {
    const opt = document.createElement('option')
    opt.value = ''
    opt.textContent = 'loading'
    modeSelect.appendChild(opt)
    modeSelect.disabled = true
    return
  }

  for (const agent of agents) {
    const opt = document.createElement('option')
    opt.value = agent.mode
    opt.textContent = agent.displayName || modeLabel(agent.mode)
    if (agent.shortDesc) opt.title = agent.shortDesc
    modeSelect.appendChild(opt)
  }

  if (selectedMode && !agents.some(agent => agent.mode === selectedMode)) {
    const opt = document.createElement('option')
    opt.value = selectedMode
    opt.textContent = state.currentModeDisplayName || modeLabel(selectedMode)
    modeSelect.appendChild(opt)
  }

  modeSelect.value = selectedMode || agents[0].mode
  modeSelect.disabled = !state.isConnected || state.isWaiting || agents.length < 2
}

function setMode(mode, displayName = '') {
  state.currentMode = mode
  state.currentModeDisplayName = displayName || modeLabel(mode)
  isPlannerMode = mode === 'planner'
  if (mode === 'executor') openPlanList()
  else closePlanWorkspace()
  syncModeSelect()
}

// ─── Input state ───

export function setChatInputEnabled(connected) {
  if (chatInput) {
    chatInput.setDisabled(!connected || state.isWaiting)
  }
  syncModeSelect()
}

export function setWaiting(waiting) {
  state.isWaiting = waiting
  if (chatInput) {
    chatInput.setDisabled(waiting || !state.isConnected)
  }
  document.querySelector('header').classList.toggle('streaming', waiting)
  if (!waiting && document.querySelector('[data-tab="chat"].active')) {
    if (chatInput) chatInput.focus()
  }
  syncModeSelect()
}

export function focusChatInput() {
  if (state.isConnected && chatInput) chatInput.focus()
}

// ─── Stream state reset (called on WS disconnect) ───

export function resetStream() {
  streamWrap = null
  streamBubbleContainer = null
  streamBubble = null
  streamRawText = ''
  reasoningEl = null
  pendingSources = null
  sourcesWrap = null
  pendingAttachments = null
  attachmentsWrap = null
}

// ─── Thinking indicator ───

export function removeThinking() {
  thinkingEl?.remove()
  thinkingEl = null
}

function showThinking(toolLabel = '', extraClass = '') {
  if (emptyEl?.parentNode) emptyEl.remove()
  if (!streamWrap) {
    const bubble = document.createElement('r-message-bubble')
    bubble.type = 'assistant'
    streamWrap = bubble
    streamBubbleContainer = bubble.bubbleContainer
    messagesEl.appendChild(streamWrap)
  }
  const indicator = document.createElement('r-thinking-indicator')
  indicator.show(toolLabel, extraClass)
  streamBubbleContainer.appendChild(indicator)
  scrollToBottom()
  thinkingEl = indicator
}

// ─── Message helpers ───

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function createReasoningSection() {
  const details = document.createElement('details')
  details.className = 'reasoning'
  const summary = document.createElement('summary')
  summary.textContent = 'Thinking...'
  const content = document.createElement('pre')
  content.className = 'reasoning-content'
  details.appendChild(summary)
  details.appendChild(content)
  return { section: details, contentEl: content }
}

function toolActionLabel(toolName) {
  if (toolName === 'web_search') return 'searching the web…'
  if (toolName === 'analyze_image') return 'analysing image…'
  return `running ${toolName}…`
}

function appendUserMessage(text, attachments = []) {
  if (emptyEl?.parentNode) emptyEl.remove()
  const bubble = document.createElement('r-message-bubble')
  bubble.type = 'user'

  const images = attachments.filter(a => a.kind === 'image')
  if (images.length > 0) {
    bubble.addImages(images)
  }

  const audio = attachments.find(a => a.kind === 'audio')
  if (audio) {
    bubble.addAudio(audio.data)
  }

  const pdfs = attachments.filter(a => a.kind === 'pdf')
  if (pdfs.length > 0) {
    bubble.addPdfs(pdfs)
  }

  if (text) {
    bubble.addText(text)
  }

  messagesEl.appendChild(bubble)
  scrollToBottom()
}

// ─── WebSocket message handler ───

export function handleChatMsg(msg) {
  if (msg.type === 'agents') {
    state.agents = Array.isArray(msg.agents) ? msg.agents : []
    syncModeSelect()
  } else if (msg.type === 'modeChanged') {
    setMode(msg.mode, msg.displayName)
  } else if (msg.type === 'plannerMode') {
    isPlannerMode = msg.active
    if (msg.active) setMode('planner', 'Planner')
    else if (state.currentMode === 'planner') setMode('chatbot', 'Chatbot')
  } else if (msg.type === 'tooling') {
    removeThinking()
    const tools = msg.tools ?? []
    const label = tools.length === 1
      ? toolActionLabel(tools[0])
      : tools.length > 1 ? `invoking ${tools.length} tools…` : 'working…'
    showThinking(label, 'searching')
  } else if (msg.type === 'sources') {
    pendingSources = msg.sources
  } else if (msg.type === 'attachments') {
    if (streamBubbleContainer) {
      const wrap = document.createElement('r-attachments')
      wrap.render(msg.attachments)
      if (streamBubble) streamBubbleContainer.insertBefore(wrap, streamBubble)
      else streamBubbleContainer.appendChild(wrap)
      attachmentsWrap = wrap
    } else {
      pendingAttachments = msg.attachments
    }
  } else if (msg.type === 'reasoningChunk') {
    removeThinking()
    if (!streamWrap) {
      const bubble = document.createElement('r-message-bubble')
      bubble.type = 'assistant'
      streamWrap = bubble
      streamBubbleContainer = bubble.bubbleContainer
      messagesEl.appendChild(streamWrap)
    }
    if (!reasoningEl) {
      const contentEl = streamWrap.addReasoningSection()
      reasoningEl = contentEl
    }
    reasoningEl.textContent += msg.text
    scrollToBottom()
  } else if (msg.type === 'chunk') {
    if (!streamBubble) {
      removeThinking()
      messagesEl.classList.add('receiving')
      setTimeout(() => messagesEl.classList.remove('receiving'), 700)
      if (!streamWrap) {
        const bubble = document.createElement('r-message-bubble')
        bubble.type = 'assistant'
        streamWrap = bubble
        streamBubbleContainer = bubble.bubbleContainer
        messagesEl.appendChild(streamWrap)
      }
      reasoningEl = null
      const bodyEl = document.createElement('div')
      bodyEl.className = 'bubble-body'
      if (pendingSources) {
        const sourcesList = document.createElement('r-sources-list')
        sourcesList.render(pendingSources)
        streamBubbleContainer.appendChild(sourcesList)
        sourcesWrap = sourcesList
        pendingSources = null
      }
      if (pendingAttachments) {
        const attachmentsEl = document.createElement('r-attachments')
        attachmentsEl.render(pendingAttachments)
        streamBubbleContainer.appendChild(attachmentsEl)
        attachmentsWrap = attachmentsEl
        pendingAttachments = null
      }
      streamBubbleContainer.appendChild(bodyEl)
      streamBubble = bodyEl
      streamRawText = ''
    }
    streamRawText += msg.text
    streamBubble.textContent = streamRawText
    scrollToBottom()
  } else if (msg.type === 'done') {
    if (streamBubble && streamRawText) {
      streamBubble.textContent = ''
      streamBubble.appendChild(renderMarkdown(streamRawText))
    }
    if (pendingAttachments) {
      if (!streamWrap) {
        const bubble = document.createElement('r-message-bubble')
        bubble.type = 'assistant'
        streamWrap = bubble
        streamBubbleContainer = bubble.bubbleContainer
        messagesEl.appendChild(streamWrap)
      }
      const attachmentsEl = document.createElement('r-attachments')
      attachmentsEl.render(pendingAttachments)
      streamBubbleContainer.appendChild(attachmentsEl)
      pendingAttachments = null
    }
    streamRawText = ''
    streamBubble = null
    streamBubbleContainer = null
    streamWrap = null
    reasoningEl = null
    sourcesWrap = null
    attachmentsWrap = null
    setWaiting(false)
  } else if (msg.type === 'error') {
    removeThinking()
    streamWrap = null
    streamBubbleContainer = null
    streamBubble = null
    streamRawText = ''
    reasoningEl = null
    pendingSources = null
    sourcesWrap = null
    pendingAttachments = null
    attachmentsWrap = null
    const bubble = document.createElement('r-message-bubble')
    bubble.type = 'error'
    const textEl = document.createElement('div')
    textEl.className = 'bubble-body'
    textEl.textContent = msg.text
    bubble.bubbleContainer.appendChild(textEl)
    messagesEl.appendChild(bubble)
    scrollToBottom()
    setWaiting(false)
  }
}

// ─── Input events ───

export function initChatInput() {
  chatInput = document.querySelector('r-chat-input')
  if (!chatInput) return

  chatInput.addEventListener('chat-submit', (e) => {
    const { text, attachments } = e.detail
    if ((!text && attachments.length === 0) || state.ws?.readyState !== WebSocket.OPEN || state.isWaiting) return

    appendUserMessage(text, attachments)
    state.ws.send(JSON.stringify({
      text,
      attachments,
    }))

    setWaiting(true)
    showThinking()

    const logoMark = document.querySelector('.logo-mark')
    logoMark.classList.add('noticing')
    setTimeout(() => logoMark.classList.remove('noticing'), 700)
  })

  modeSelect?.addEventListener('change', () => {
    const mode = modeSelect.value
    if (!mode || mode === state.currentMode || state.ws?.readyState !== WebSocket.OPEN) {
      syncModeSelect()
      return
    }
    state.ws.send(JSON.stringify({ type: 'switchMode', mode }))
    modeSelect.disabled = true
  })
}
