import { state } from '../state.js'
import { renderMarkdown } from '../markdown.js'
import { getPendingImages, getPendingAudio, getPendingPdfs, clearPendingImages, clearPendingAudio, clearPendingPdfs } from './media.js'

const messagesEl      = document.getElementById('messages')
const emptyEl         = document.getElementById('empty')
const chatForm        = document.getElementById('chat-form')
const input           = document.getElementById('input')
const send            = document.getElementById('send')

let thinkingEl            = null
let streamWrap            = null
let streamBubbleContainer = null
let streamBubble          = null
let streamRawText         = ''
let reasoningEl           = null
let pendingSources        = null
let sourcesWrap           = null

// ─── Input state ───

export function setChatInputEnabled(connected) {
  input.disabled = !connected || state.isWaiting
  send.disabled  = !connected || state.isWaiting
}

export function setWaiting(waiting) {
  state.isWaiting = waiting
  input.disabled  = waiting || !state.isConnected
  send.disabled   = waiting || !state.isConnected
  document.querySelector('header').classList.toggle('streaming', waiting)
  if (!waiting && document.querySelector('[data-tab="chat"].active')) input.focus()
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
  label.textContent = 'Rorschach'
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

function toolActionLabel(toolName) {
  if (toolName === 'web_search')    return 'searching the web…'
  if (toolName === 'analyze_image') return 'analysing image…'
  return `running ${toolName}…`
}

function appendUserMessage(text, images, audio, pdfs = []) {
  if (emptyEl?.parentNode) emptyEl.remove()
  const wrap   = document.createElement('div')
  wrap.className = 'message user'
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  const label  = document.createElement('div')
  label.className = 'message-label'
  label.textContent = 'You'
  bubble.appendChild(label)
  if (images && images.length > 0) {
    const imgRow = document.createElement('div')
    imgRow.className = 'message-images'
    images.forEach(src => {
      const img = document.createElement('img')
      img.src = src
      img.className = 'message-image'
      imgRow.appendChild(img)
    })
    bubble.appendChild(imgRow)
  }
  if (audio) {
    const audioEl = document.createElement('audio')
    audioEl.src = audio
    audioEl.controls = true
    audioEl.className = 'message-audio'
    bubble.appendChild(audioEl)
  }
  if (pdfs && pdfs.length > 0) {
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
  if (msg.type === 'searching') {
    removeThinking()
    const tools = msg.tools ?? []
    const label = tools.length === 1
      ? toolActionLabel(tools[0])
      : tools.length > 1 ? `invoking ${tools.length} tools…` : 'working…'
    showThinking(label, 'searching')
  } else if (msg.type === 'sources') {
    pendingSources = msg.sources
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
    streamRawText         = ''
    streamBubble          = null
    streamBubbleContainer = null
    streamWrap            = null
    reasoningEl           = null
    sourcesWrap           = null
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

chatForm.addEventListener('submit', (e) => {
  e.preventDefault()
  const text   = input.value.trim()
  const images = getPendingImages()
  const audio  = getPendingAudio()
  const pdfs   = getPendingPdfs()

  if ((!text && images.length === 0 && !audio && pdfs.length === 0) || state.ws?.readyState !== WebSocket.OPEN || state.isWaiting) return

  appendUserMessage(text, images.slice(), audio, pdfs.slice())
  state.ws.send(JSON.stringify({
    text,
    images: images.slice(),
    ...(audio ? { audio } : {}),
    ...(pdfs.length > 0 ? { pdfs: pdfs.map(p => ({ data: p.dataUrl, name: p.name })) } : {}),
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
