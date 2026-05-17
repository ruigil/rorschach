import { state } from '../state.js'
import { renderMarkdown } from '../markdown.js'
import { getPendingImages, getPendingAudio, getPendingPdfs, clearPendingImages, clearPendingAudio, clearPendingPdfs } from './media.js'
import { openPlanList, closePlanWorkspace } from './plan-workspace.js'

const messagesEl      = document.getElementById('messages')
const emptyEl         = document.getElementById('empty')
const chatForm        = document.getElementById('chat-form')
const input           = document.getElementById('input')
const send            = document.getElementById('send')
const modeSelect      = document.getElementById('mode-select')

let thinkingEl            = null
let streamWrap            = null
let streamBubbleContainer = null
let streamBubble          = null
let streamRawText         = ''
let reasoningEl           = null
let pendingSources        = null
let sourcesWrap           = null
let pendingAttachments    = null
let attachmentsWrap       = null
let isPlannerMode         = false

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
  input.disabled = !connected || state.isWaiting
  send.disabled  = !connected || state.isWaiting
  syncModeSelect()
}

export function setWaiting(waiting) {
  state.isWaiting = waiting
  input.disabled  = waiting || !state.isConnected
  send.disabled   = waiting || !state.isConnected
  document.querySelector('header').classList.toggle('streaming', waiting)
  if (!waiting && document.querySelector('[data-tab="chat"].active')) input.focus()
  syncModeSelect()
}

export function focusChatInput() {
  if (state.isConnected) input.focus()
}

// ─── Stream state reset (called on WS disconnect) ───

export function resetStream() {
  streamWrap            = null
  streamBubbleContainer = null
  streamBubble          = null
  streamRawText         = ''
  reasoningEl           = null
  pendingSources        = null
  sourcesWrap           = null
  pendingAttachments    = null
  attachmentsWrap       = null
}

// ─── Thinking indicator ───

export function removeThinking() {
  thinkingEl?.remove()
  thinkingEl = null
}

function showThinking(toolLabel = '', extraClass = '') {
  if (emptyEl?.parentNode) emptyEl.remove()
  if (!streamWrap) {
    const { wrap, bubble } = createMessageWrap()
    streamWrap = wrap
    streamBubbleContainer = bubble
    messagesEl.appendChild(streamWrap)
  }
  const indicator = document.createElement('div')
  indicator.className = 'tool-indicator' + (extraClass ? ' ' + extraClass : '')
  if (toolLabel) {
    const badge = document.createElement('div')
    badge.className = 'tool-badge'
    badge.textContent = toolLabel
    indicator.appendChild(badge)
  }
  const dotsRow = document.createElement('div')
  dotsRow.className = 'dots-row'
  ;['dot', 'dot', 'dot'].forEach(() => {
    const d = document.createElement('div')
    d.className = 'dot'
    dotsRow.appendChild(d)
  })
  indicator.appendChild(dotsRow)
  streamBubbleContainer.appendChild(indicator)
  scrollToBottom()
  thinkingEl = indicator
}

// ─── Message helpers ───

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function createMessageWrap() {
  const wrap   = document.createElement('div')
  wrap.className = 'message assistant'
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  const label  = document.createElement('div')
  label.className = 'message-label'
  label.textContent = state.currentMode
    ? `Rorschach — ${modeLabel(state.currentMode, state.currentModeDisplayName)} Mode`
    : 'Rorschach'
  bubble.appendChild(label)
  wrap.appendChild(bubble)
  return { wrap, bubble }
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

function renderSources(sources) {
  const wrap   = document.createElement('div')
  wrap.className = 'sources'
  const toggle = document.createElement('button')
  toggle.className = 'sources-toggle'
  toggle.textContent = `${sources.length} source${sources.length !== 1 ? 's' : ''}`
  const list   = document.createElement('div')
  list.className = 'sources-list'
  sources.forEach((s) => {
    const item = document.createElement('a')
    item.className = 'source-item'
    item.href = s.url
    item.target = '_blank'
    item.rel = 'noopener noreferrer'
    const title = document.createElement('span')
    title.className = 'source-title'
    title.textContent = s.title
    const snippet = document.createElement('span')
    snippet.className = 'source-snippet'
    snippet.textContent = s.snippet
    item.appendChild(title)
    if (s.snippet) item.appendChild(snippet)
    list.appendChild(item)
  })
  toggle.addEventListener('click', () => {
    const open = list.classList.toggle('open')
    toggle.classList.toggle('open', open)
  })
  wrap.appendChild(toggle)
  wrap.appendChild(list)
  return wrap
}

function renderAttachments(attachments) {
  const wrap = document.createElement('div')
  wrap.className = 'attachments'
  attachments.forEach((a) => {
    const item = document.createElement('div')
    item.className = `attachment attachment-${a.kind}`
    if (a.kind === 'image') {
      const img = document.createElement('img')
      img.src = a.url
      img.className = 'attachment-image'
      if (a.alt) img.alt = a.alt
      item.appendChild(img)
    } else if (a.kind === 'audio') {
      const audio = document.createElement('audio')
      audio.src = a.url
      audio.controls = true
      audio.className = 'attachment-audio'
      item.appendChild(audio)
      if (a.alt) {
        const caption = document.createElement('div')
        caption.className = 'attachment-caption'
        caption.textContent = a.alt
        item.appendChild(caption)
      }
    } else if (a.kind === 'video') {
      const video = document.createElement('video')
      video.src = a.url
      video.controls = true
      video.className = 'attachment-video'
      item.appendChild(video)
      if (a.alt) {
        const caption = document.createElement('div')
        caption.className = 'attachment-caption'
        caption.textContent = a.alt
        item.appendChild(caption)
      }
    } else {
      const link = document.createElement('a')
      link.href = a.url
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.className = 'attachment-file'
      link.textContent = a.alt || a.url.split('/').pop() || 'file'
      item.appendChild(link)
    }
    wrap.appendChild(item)
  })
  return wrap
}

function toolActionLabel(toolName) {
  if (toolName === 'web_search')    return 'searching the web…'
  if (toolName === 'analyze_image') return 'analysing image…'
  return `running ${toolName}…`
}

function appendUserMessage(text, attachments = []) {
  if (emptyEl?.parentNode) emptyEl.remove()
  const wrap   = document.createElement('div')
  wrap.className = 'message user'
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  const label  = document.createElement('div')
  label.className = 'message-label'
  label.textContent = 'You'
  bubble.appendChild(label)

  const images = attachments.filter(a => a.kind === 'image')
  if (images.length > 0) {
    const imgRow = document.createElement('div')
    imgRow.className = 'message-images'
    images.forEach(a => {
      const img = document.createElement('img')
      img.src = a.data
      img.className = 'message-image'
      imgRow.appendChild(img)
    })
    bubble.appendChild(imgRow)
  }

  const audio = attachments.find(a => a.kind === 'audio')
  if (audio) {
    const audioEl = document.createElement('audio')
    audioEl.src = audio.data
    audioEl.controls = true
    audioEl.className = 'message-audio'
    bubble.appendChild(audioEl)
  }

  const pdfs = attachments.filter(a => a.kind === 'pdf')
  if (pdfs.length > 0) {
    pdfs.forEach(pdf => {
      const chip = document.createElement('div')
      chip.className = 'message-pdf-chip'
      chip.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
      const nameSpan = document.createElement('span')
      nameSpan.textContent = pdf.name
      chip.appendChild(nameSpan)
      bubble.appendChild(chip)
    })
  }

  if (text) {
    const textEl = document.createElement('span')
    textEl.textContent = text
    bubble.appendChild(textEl)
  }
  wrap.appendChild(bubble)
  messagesEl.appendChild(wrap)
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
      const wrap = renderAttachments(msg.attachments)
      if (streamBubble) streamBubbleContainer.insertBefore(wrap, streamBubble)
      else streamBubbleContainer.appendChild(wrap)
      attachmentsWrap = wrap
    } else {
      pendingAttachments = msg.attachments
    }
  } else if (msg.type === 'reasoningChunk') {
    removeThinking()
    if (!streamWrap) {
      const { wrap, bubble } = createMessageWrap()
      streamWrap = wrap
      streamBubbleContainer = bubble
      messagesEl.appendChild(streamWrap)
    }
    if (!reasoningEl) {
      const { section, contentEl } = createReasoningSection()
      streamBubbleContainer.appendChild(section)
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
        const { wrap, bubble } = createMessageWrap()
        streamWrap = wrap
        streamBubbleContainer = bubble
        messagesEl.appendChild(streamWrap)
      }
      reasoningEl = null
      const bodyEl = document.createElement('div')
      bodyEl.className = 'bubble-body'
      if (pendingSources) {
        sourcesWrap = renderSources(pendingSources)
        streamBubbleContainer.appendChild(sourcesWrap)
        pendingSources = null
      }
      if (pendingAttachments) {
        attachmentsWrap = renderAttachments(pendingAttachments)
        streamBubbleContainer.appendChild(attachmentsWrap)
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
        const { wrap, bubble } = createMessageWrap()
        streamWrap = wrap
        streamBubbleContainer = bubble
        messagesEl.appendChild(streamWrap)
      }
      streamBubbleContainer.appendChild(renderAttachments(pendingAttachments))
      pendingAttachments = null
    }
    streamRawText         = ''
    streamBubble          = null
    streamBubbleContainer = null
    streamWrap            = null
    reasoningEl           = null
    sourcesWrap           = null
    attachmentsWrap       = null
    setWaiting(false)
  } else if (msg.type === 'error') {
    removeThinking()
    streamWrap            = null
    streamBubbleContainer = null
    streamBubble          = null
    streamRawText         = ''
    reasoningEl           = null
    pendingSources        = null
    sourcesWrap           = null
    pendingAttachments    = null
    attachmentsWrap       = null
    const wrap   = document.createElement('div')
    wrap.className = 'message error'
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    const label  = document.createElement('div')
    label.className = 'message-label'
    label.textContent = 'Error'
    bubble.appendChild(label)
    const textEl = document.createElement('div')
    textEl.className = 'bubble-body'
    textEl.textContent = msg.text
    bubble.appendChild(textEl)
    wrap.appendChild(bubble)
    messagesEl.appendChild(wrap)
    scrollToBottom()
    setWaiting(false)
  }
}

// ─── Input events ───

input.addEventListener('input', () => {
  input.style.height = 'auto'
  input.style.height = Math.min(input.scrollHeight, 150) + 'px'
})

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    chatForm.dispatchEvent(new Event('submit'))
  }
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

chatForm.addEventListener('submit', (e) => {
  e.preventDefault()
  const text   = input.value.trim()
  const images = getPendingImages()
  const audio  = getPendingAudio()
  const pdfs   = getPendingPdfs()

  const attachments = [
    ...images.map(data => ({ kind: 'image', data })),
    ...(audio ? [{ kind: 'audio', data: audio }] : []),
    ...pdfs.map(p => ({ kind: 'pdf', data: p.dataUrl, name: p.name })),
  ]

  if ((!text && attachments.length === 0) || state.ws?.readyState !== WebSocket.OPEN || state.isWaiting) return

  appendUserMessage(text, attachments)
  state.ws.send(JSON.stringify({
    text,
    attachments,
  }))

  input.value = ''
  input.style.height = 'auto'
  clearPendingImages()
  clearPendingAudio()
  clearPendingPdfs()
  setWaiting(true)
  showThinking()

  const logoMark = document.querySelector('.logo-mark')
  logoMark.classList.add('noticing')
  setTimeout(() => logoMark.classList.remove('noticing'), 700)
})
