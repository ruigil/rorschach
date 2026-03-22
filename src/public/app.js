// ─── Markdown renderer ───

marked.use({ gfm: true, breaks: true })

function copyCode(btn) {
  const code = btn.closest('.code-block').querySelector('code').textContent
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = 'copied'
    setTimeout(() => { btn.textContent = 'copy' }, 1800)
  })
}

function renderMarkdown(text) {
  const el = document.createElement('div')
  el.className = 'md'
  el.innerHTML = marked.parse(text)
  el.querySelectorAll('pre > code').forEach(block => {
    const langClass = Array.from(block.classList).find(c => c.startsWith('language-'))
    const lang = langClass ? langClass.replace('language-', '') : 'code'
    hljs.highlightElement(block)
    const pre = block.parentElement
    const wrapper = document.createElement('div')
    wrapper.className = 'code-block'
    const header = document.createElement('div')
    header.className = 'code-header'
    header.innerHTML = `<span class="code-lang">${lang}</span><button class="copy-btn" onclick="copyCode(this)">copy</button>`
    pre.replaceWith(wrapper)
    wrapper.appendChild(header)
    wrapper.appendChild(pre)
  })
  return el
}

// ─── Tab switching ───

const tabBtns = document.querySelectorAll('[data-tab]')
const logoSub = document.getElementById('logo-sub')

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
    document.getElementById('panel-' + btn.dataset.tab).classList.add('active')
    logoSub.textContent = btn.dataset.tab
    if (btn.dataset.tab === 'chat' && isConnected) input.focus()
  })
})

// ─── Shared WebSocket ───

let isConnected = false
let isWaiting   = false
let ws          = null

const dot         = document.getElementById('dot')
const statusLabel = document.getElementById('status-label')

function setConnected(connected) {
  isConnected = connected
  dot.className = 'header-dot ' + (connected ? 'connected' : 'disconnected')
  statusLabel.textContent = connected ? 'connected' : 'reconnecting…'
  input.disabled  = !connected || isWaiting
  send.disabled   = !connected || isWaiting
}

function connect() {
  const wsUrl = new URL('ws', location.href)
  wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(wsUrl.href)

  ws.addEventListener('open', () => {
    setConnected(true)
    if (document.querySelector('[data-tab="chat"].active')) input.focus()
  })

  ws.addEventListener('close', () => {
    setConnected(false)
    removeThinking()
    streamWrap = null
    streamBubble = null
    streamRawText = ''
    reasoningEl = null
    pendingSources = null
    sourcesWrap = null
    setWaiting(false)
    setTimeout(connect, 2000)
  })

  ws.addEventListener('error', () => ws.close())

  ws.addEventListener('message', (e) => {
    let msg
    try { msg = JSON.parse(e.data) } catch { return }

    if (msg.type === 'chunk' || msg.type === 'done' || msg.type === 'error' || msg.type === 'searching' || msg.type === 'sources' || msg.type === 'reasoningChunk') {
      handleChatMsg(msg)
    } else if (msg.type === 'log') {
      appendLog(msg)
    } else if (msg.type === 'metrics') {
      updateMetrics(msg)
    } else if (msg.type === 'trace') {
      onTraceSpan(msg)
    }
  })
}

// ─── Chat ───

const messagesEl = document.getElementById('messages')
const emptyEl    = document.getElementById('empty')
const chatForm   = document.getElementById('chat-form')
const input      = document.getElementById('input')
const send       = document.getElementById('send')

let thinkingEl   = null
let streamWrap   = null
let streamBubble = null
let streamRawText = ''
let reasoningEl  = null
let pendingSources = null
let sourcesWrap  = null

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
  const text = input.value.trim()
  if (!text || ws?.readyState !== WebSocket.OPEN || isWaiting) return
  appendMessage('user', text)
  ws.send(text)
  input.value = ''
  input.style.height = 'auto'
  setWaiting(true)
  showThinking()
})

function setWaiting(waiting) {
  isWaiting = waiting
  input.disabled  = waiting || !isConnected
  send.disabled   = waiting || !isConnected
  if (!waiting && document.querySelector('[data-tab="chat"].active')) input.focus()
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function appendMessage(role, text) {
  if (emptyEl?.parentNode) emptyEl.remove()
  const wrap   = document.createElement('div')
  wrap.className = `message ${role}`
  const label  = document.createElement('div')
  label.className = 'message-label'
  label.textContent = role === 'user' ? 'You' : role === 'assistant' ? 'Rorschach' : 'Error'
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  bubble.textContent = text
  wrap.appendChild(label)
  wrap.appendChild(bubble)
  messagesEl.appendChild(wrap)
  scrollToBottom()
  return wrap
}

function showThinking(label = 'Rorschach', extraClass = '') {
  if (emptyEl?.parentNode) emptyEl.remove()
  const wrap   = document.createElement('div')
  wrap.className = 'message assistant thinking' + (extraClass ? ' ' + extraClass : '')
  const labelEl = document.createElement('div')
  labelEl.className = 'message-label'
  labelEl.textContent = label
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  bubble.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>'
  wrap.appendChild(labelEl)
  wrap.appendChild(bubble)
  messagesEl.appendChild(wrap)
  scrollToBottom()
  thinkingEl = wrap
}

function removeThinking() {
  thinkingEl?.remove()
  thinkingEl = null
}

function renderSources(sources) {
  const wrap = document.createElement('div')
  wrap.className = 'sources'
  const toggle = document.createElement('button')
  toggle.className = 'sources-toggle'
  toggle.textContent = `${sources.length} source${sources.length !== 1 ? 's' : ''}`
  const list = document.createElement('div')
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

function createMessageWrap() {
  const wrap  = document.createElement('div')
  wrap.className = 'message assistant'
  const label = document.createElement('div')
  label.className = 'message-label'
  label.textContent = 'Rorschach'
  wrap.appendChild(label)
  return wrap
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

function handleChatMsg(msg) {
  if (msg.type === 'searching') {
    removeThinking()
    showThinking('searching the web…', 'searching')
  } else if (msg.type === 'sources') {
    pendingSources = msg.sources
  } else if (msg.type === 'reasoningChunk') {
    if (!streamWrap) {
      removeThinking()
      streamWrap = createMessageWrap()
      messagesEl.appendChild(streamWrap)
    }
    if (!reasoningEl) {
      const { section, contentEl } = createReasoningSection()
      streamWrap.appendChild(section)
      reasoningEl = contentEl
    }
    reasoningEl.textContent += msg.text
    scrollToBottom()
  } else if (msg.type === 'chunk') {
    if (!streamBubble) {
      removeThinking()
      if (!streamWrap) {
        streamWrap = createMessageWrap()
        messagesEl.appendChild(streamWrap)
      }
      reasoningEl = null
      const bubble = document.createElement('div')
      bubble.className = 'bubble'
      if (pendingSources) {
        sourcesWrap = renderSources(pendingSources)
        streamWrap.appendChild(sourcesWrap)
        pendingSources = null
      }
      streamWrap.appendChild(bubble)
      streamBubble = bubble
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
    streamRawText = ''
    streamBubble = null
    streamWrap = null
    reasoningEl = null
    sourcesWrap = null
    setWaiting(false)
  } else if (msg.type === 'error') {
    removeThinking()
    streamWrap = null
    streamBubble = null
    streamRawText = ''
    reasoningEl = null
    pendingSources = null
    sourcesWrap = null
    appendMessage('error', msg.text)
    setWaiting(false)
  }
}

// ─── Observe ───

const logStream      = document.getElementById('log-stream')
const logEmpty       = document.getElementById('log-empty')
const logCountEl     = document.getElementById('log-count')
const clearBtn       = document.getElementById('clear-logs')
const actorTreeEl    = document.getElementById('actor-tree')
const metricsEmpty   = document.getElementById('metrics-empty')
const metricsSummary = document.getElementById('metrics-summary')
const sumActors      = document.getElementById('sum-actors')
const sumRecv        = document.getElementById('sum-recv')
const sumDone        = document.getElementById('sum-done')
const sumFail        = document.getElementById('sum-fail')
const actorDetailEl  = document.getElementById('actor-detail')
const obsLogControls = document.getElementById('obs-log-controls')
const topicListEl    = document.getElementById('topic-list')
const topicsEmpty    = document.getElementById('topics-empty')

const obsTracesControls = document.getElementById('obs-traces-controls')
const tracesCountEl      = document.getElementById('traces-count')
const clearTracesBtn     = document.getElementById('clear-traces')
const tracesListEl       = document.getElementById('obs-traces-list')
const tracesEmptyEl      = document.getElementById('traces-empty')

// tracesMap: Map<traceId, TraceRecord>
// TraceRecord = { traceId, requestStart, requestEnd?, requestDuration?, spans: Map<spanId, SpanData> }
// SpanData = { spanId, parentSpanId?, actor, operation, startTime, endTime?, durationMs?, status, data? }
const tracesMap = new Map()
const MAX_TRACES = 20

function onTraceSpan(span) {
  let record = tracesMap.get(span.traceId)
  if (!record) {
    if (tracesMap.size >= MAX_TRACES) {
      tracesMap.delete(tracesMap.keys().next().value)
    }
    record = { traceId: span.traceId, requestStart: span.timestamp, spans: new Map() }
    tracesMap.set(span.traceId, record)
  }

  let spanData = record.spans.get(span.spanId)
  if (!spanData) {
    spanData = {
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      actor: span.actor,
      operation: span.operation,
      startTime: span.timestamp,
      status: span.status,
      data: span.data,
    }
    record.spans.set(span.spanId, spanData)
  } else {
    spanData.endTime = span.timestamp
    spanData.durationMs = span.durationMs
    spanData.status = span.status
    if (span.data) spanData.data = Object.assign({}, spanData.data, span.data)
  }

  if (span.operation === 'request' && (span.status === 'done' || span.status === 'error')) {
    record.requestDuration = span.durationMs
    record.requestEnd = span.timestamp
  }

  if (document.querySelector('.obs-subtab[data-subtab="traces"].active')) {
    renderTraces()
  }
  tracesCountEl.textContent = `${tracesMap.size} trace${tracesMap.size !== 1 ? 's' : ''}`
}

function computeDepths(spans) {
  const depthMap = new Map()
  const spanMap = new Map(spans.map(s => [s.spanId, s]))
  const getDepth = (span) => {
    if (depthMap.has(span.spanId)) return depthMap.get(span.spanId)
    if (!span.parentSpanId) { depthMap.set(span.spanId, 0); return 0 }
    const parent = spanMap.get(span.parentSpanId)
    const d = parent ? getDepth(parent) + 1 : 0
    depthMap.set(span.spanId, d)
    return d
  }
  spans.forEach(s => getDepth(s))
  return depthMap
}

function renderSpanRow(span, traceStart, totalMs, depth) {
  const offset = Math.max(0, ((span.startTime - traceStart) / totalMs) * 100)
  const duration = span.durationMs ?? (Date.now() - span.startTime)
  const width = Math.max(0.5, Math.min(100 - offset, (duration / totalMs) * 100))
  const isActive = span.status === 'started'
  const isError = span.status === 'error'
  const opClass = 'op-' + span.operation.replace(/[^a-z0-9]/g, '-')
  const dur = span.durationMs != null ? span.durationMs + 'ms' : '…'
  const actorShort = span.actor.split('/').pop() ?? span.actor

  return `
    <div class="waterfall-row" style="padding-left:${8 + depth * 12}px">
      <div class="waterfall-label">
        <span class="wf-actor">${escHtml(actorShort)}</span>
        <span class="wf-op">${escHtml(span.operation)}</span>
      </div>
      <div class="waterfall-track">
        <div class="waterfall-bar ${opClass}${isActive ? ' wf-active' : ''}${isError ? ' wf-error' : ''}"
             style="left:${offset.toFixed(1)}%;width:${width.toFixed(1)}%"></div>
      </div>
      <div class="waterfall-dur">${escHtml(dur)}</div>
    </div>`
}

function renderTrace(record) {
  const spans = Array.from(record.spans.values())
  const now = Date.now()
  const totalMs = record.requestDuration ?? (now - record.requestStart)
  const isLive = !record.requestEnd
  const depthMap = computeDepths(spans)
  const sorted = [...spans].sort((a, b) => a.startTime - b.startTime)
  const rows = sorted.map(s => renderSpanRow(s, record.requestStart, totalMs, depthMap.get(s.spanId) ?? 0)).join('')
  const durStr = record.requestDuration != null ? record.requestDuration + 'ms' : '…'
  const traceIdShort = record.traceId.slice(-10)

  return `
    <div class="trace-item${isLive ? ' wf-live' : ''}">
      <div class="trace-header">
        <span class="trace-id">${escHtml(traceIdShort)}</span>
        <span class="trace-dur">${escHtml(durStr)}</span>
        ${isLive ? '<span class="trace-live-badge">live</span>' : ''}
      </div>
      <div class="trace-waterfall">${rows}</div>
    </div>`
}

function renderTraces() {
  if (tracesEmptyEl?.parentNode) tracesEmptyEl.remove()
  if (tracesMap.size === 0) {
    tracesListEl.innerHTML = ''
    if (!tracesListEl.querySelector('.empty-panel')) {
      const e = document.createElement('div')
      e.className = 'empty-panel'
      e.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg><span>awaiting traces</span>`
      tracesListEl.appendChild(e)
    }
    return
  }
  const arr = Array.from(tracesMap.values()).reverse()
  tracesListEl.innerHTML = arr.map(renderTrace).join('')
}

clearTracesBtn.addEventListener('click', () => {
  tracesMap.clear()
  tracesCountEl.textContent = '0 traces'
  renderTraces()
})

let logCount      = 0
const MAX_LOGS    = 500

let actorsMap     = {}
let selectedActor = null
const collapsedSet = new Set()

let topicsData    = []
const expandedTopics = new Set()

// Observe subtab switching
document.querySelectorAll('.obs-subtab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.obs-subtab').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    document.querySelectorAll('.obs-subpanel').forEach(p => p.classList.remove('active'))
    document.getElementById('obs-' + btn.dataset.subtab).classList.add('active')
    const subtab = btn.dataset.subtab
    metricsSummary.style.display = subtab === 'metrics' && Object.keys(actorsMap).length > 0 ? 'flex' : 'none'
    obsLogControls.style.display = subtab === 'logs' ? 'flex' : 'none'
    obsTracesControls.style.display = subtab === 'traces' ? 'flex' : 'none'
    if (subtab === 'traces') renderTraces()
  })
})


function tsStr(timestamp) {
  return new Date(timestamp).toISOString().slice(11, 23)
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function appendLog(event) {
  if (logEmpty?.parentNode) logEmpty.remove()

  if (logCount >= MAX_LOGS) {
    logStream.querySelector('.log-entry:last-child')?.remove()
    logCount--
  }

  const level = event.level || 'info'
  const entry = document.createElement('div')
  entry.className = 'log-entry'
  const data = event.data !== undefined
    ? `<span class="log-data">${JSON.stringify(event.data)}</span>`
    : ''
  entry.innerHTML = `
    <span class="log-ts">${tsStr(event.timestamp || Date.now())}</span>
    <span class="log-level ${level}">${level.toUpperCase()}</span>
    <span class="log-body">
      <span class="log-source">[${event.source || '?'}]</span><span class="log-msg ${level}">${escHtml(event.message || '')}</span>${data}
    </span>
  `
  logStream.prepend(entry)
  logCount++
  logCountEl.textContent = `${logCount} event${logCount !== 1 ? 's' : ''}`
}

// ─── Actor tree ───

const CHEVRON_DOWN  = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`
const CHEVRON_RIGHT = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`

function buildActorTree(actors) {
  const nodes = {}
  actors.forEach(a => {
    const parts = a.name.split('/')
    parts.forEach((_, i) => {
      const path  = parts.slice(0, i + 1).join('/')
      const label = parts[i]
      if (!nodes[path]) nodes[path] = { label, path, children: [], data: null }
    })
    nodes[a.name].data = a
  })
  const roots = []
  Object.values(nodes).forEach(node => {
    const parts = node.path.split('/')
    if (parts.length === 1) {
      roots.push(node)
    } else {
      const parentPath = parts.slice(0, -1).join('/')
      nodes[parentPath] ? nodes[parentPath].children.push(node) : roots.push(node)
    }
  })
  const sort = arr => { arr.sort((a, b) => a.label.localeCompare(b.label)); arr.forEach(n => sort(n.children)); return arr }
  return sort(roots)
}

function renderTreeNodes(nodes, depth) {
  return nodes.map(node => {
    const hasChildren = node.children.length > 0
    const isCollapsed = collapsedSet.has(node.path)
    const isSelected  = selectedActor === node.path
    const status      = node.data?.status || (hasChildren && !node.data ? null : 'running')
    const padLeft     = `${0.6 + depth * 1.1}rem`

    const chevron = hasChildren
      ? `<span class="tree-chevron" data-path="${node.path}">${isCollapsed ? CHEVRON_RIGHT : CHEVRON_DOWN}</span>`
      : `<span class="tree-spacer"></span>`

    const dot = status
      ? `<span class="tree-dot ${status}"></span>`
      : `<span class="tree-dot-empty"></span>`

    const count = node.data ? `<span class="tree-msg-count">${node.data.messagesProcessed ?? 0}</span>` : ''

    const children = hasChildren && !isCollapsed
      ? `<div class="tree-children">${renderTreeNodes(node.children, depth + 1)}</div>`
      : ''

    return `
      <div class="tree-node">
        <div class="tree-row${isSelected ? ' selected' : ''}" style="padding-left:${padLeft}" data-path="${node.path}" data-has-data="${!!node.data}">
          ${chevron}${dot}<span class="tree-label">${escHtml(node.label)}</span>${count}
        </div>
        ${children}
      </div>
    `
  }).join('')
}

function rerenderTree() {
  const roots = buildActorTree(Object.values(actorsMap))
  actorTreeEl.innerHTML = roots.length ? renderTreeNodes(roots, 0) : ''
}

// Event delegation — single listener for the whole tree
actorTreeEl.addEventListener('click', e => {
  const row = e.target.closest('.tree-row')
  if (!row) return
  const path    = row.dataset.path
  const hasData = row.dataset.hasData === 'true'

  if (e.target.closest('.tree-chevron')) {
    collapsedSet.has(path) ? collapsedSet.delete(path) : collapsedSet.add(path)
    rerenderTree()
    return
  }

  if (hasData) {
    selectedActor = path
    rerenderTree()
    renderActorDetail(actorsMap[path])
  } else {
    collapsedSet.has(path) ? collapsedSet.delete(path) : collapsedSet.add(path)
    rerenderTree()
  }
})

function renderActorDetail(actor) {
  if (!actor) {
    actorDetailEl.innerHTML = `
      <div class="empty-panel">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
        </svg>
        <span>select an actor to inspect</span>
      </div>`
    return
  }

  const status = actor.status || 'running'
  const failed = actor.messagesFailed ?? 0
  const avg    = typeof actor.processingTime?.avg === 'number' ? actor.processingTime.avg.toFixed(2) : '—'
  const min    = typeof actor.processingTime?.min === 'number' ? actor.processingTime.min.toFixed(2) : '—'
  const max    = typeof actor.processingTime?.max === 'number' ? actor.processingTime.max.toFixed(2) : '—'

  const parts = actor.name.split('/')
  const breadcrumb = parts.map((p, i) =>
    i < parts.length - 1
      ? `<span class="crumb">${escHtml(p)}</span><span class="crumb-sep">/</span>`
      : `<span class="crumb active">${escHtml(p)}</span>`
  ).join('')

  const stateSection = actor.state !== undefined && actor.state !== null
    ? `<div class="detail-section-label">state</div>
       <pre class="detail-state">${escHtml(JSON.stringify(actor.state, null, 2))}</pre>`
    : ''

  actorDetailEl.innerHTML = `
    <div class="detail-head">
      <div class="detail-path">${breadcrumb}</div>
      <span class="actor-status ${status}">${status}</span>
    </div>
    <div class="detail-divider"></div>
    <div class="detail-section-label">messages</div>
    <div class="detail-grid">
      <div class="detail-stat">
        <span class="ds-val">${actor.messagesReceived ?? 0}</span>
        <span class="ds-key">received</span>
      </div>
      <div class="detail-stat">
        <span class="ds-val">${actor.messagesProcessed ?? 0}</span>
        <span class="ds-key">processed</span>
      </div>
      <div class="detail-stat${failed > 0 ? ' error' : ''}">
        <span class="ds-val${failed > 0 ? ' error' : ''}">${failed}</span>
        <span class="ds-key">failed</span>
      </div>
      <div class="detail-stat">
        <span class="ds-val">${actor.mailboxSize ?? 0}</span>
        <span class="ds-key">mailbox</span>
      </div>
    </div>
    <div class="detail-section-label">processing time</div>
    <div class="detail-grid three">
      <div class="detail-stat">
        <span class="ds-val sm">${avg} <span class="ds-unit">ms</span></span>
        <span class="ds-key">average</span>
      </div>
      <div class="detail-stat">
        <span class="ds-val sm">${min} <span class="ds-unit">ms</span></span>
        <span class="ds-key">minimum</span>
      </div>
      <div class="detail-stat">
        <span class="ds-val sm">${max} <span class="ds-unit">ms</span></span>
        <span class="ds-key">maximum</span>
      </div>
    </div>
    ${stateSection}
  `
}

function updateMetrics(event) {
  if (metricsEmpty?.parentNode) metricsEmpty.remove()

  const actors = event.actors || []
  let totRecv = 0, totDone = 0, totFail = 0
  actors.forEach(a => {
    totRecv += a.messagesReceived || 0
    totDone += a.messagesProcessed || 0
    totFail += a.messagesFailed || 0
    actorsMap[a.name] = a
  })

  const seen = new Set(actors.map(a => a.name))
  Object.keys(actorsMap).forEach(k => { if (!seen.has(k)) delete actorsMap[k] })
  if (selectedActor && !actorsMap[selectedActor]) selectedActor = null

  if (actors.length > 0) {
    const isMetricsActive = !!document.querySelector('.obs-subtab[data-subtab="metrics"].active')
    metricsSummary.style.display = isMetricsActive ? 'flex' : 'none'
    sumActors.textContent = actors.length
    sumRecv.textContent   = totRecv
    sumDone.textContent   = totDone
    sumFail.textContent   = totFail
  }

  rerenderTree()
  if (selectedActor && actorsMap[selectedActor]) {
    renderActorDetail(actorsMap[selectedActor])
  }

  if (event.topics) updateTopics(event.topics)
}

function renderTopicEntry(t, label) {
  const displayLabel = label ?? t.topic
  const isExpanded = expandedTopics.has(t.topic)
  const subCount = t.subscribers.length
  const chevron = subCount > 0
    ? `<span class="tree-chevron topic-chevron" data-topic="${escHtml(t.topic)}">${isExpanded ? CHEVRON_DOWN : CHEVRON_RIGHT}</span>`
    : `<span class="tree-spacer"></span>`
  const subs = isExpanded && subCount > 0
    ? `<div class="topic-subscribers">${t.subscribers.map(s =>
        `<div class="topic-sub-row"><span class="topic-sub-name">${escHtml(s)}</span></div>`
      ).join('')}</div>`
    : ''
  return `
    <div class="topic-entry">
      <div class="topic-row" data-topic="${escHtml(t.topic)}" data-has-subs="${subCount > 0}">
        ${chevron}
        <span class="topic-name">${escHtml(displayLabel)}</span>
        <span class="topic-sub-count">${subCount}</span>
      </div>
      ${subs}
    </div>`
}

function updateTopics(topics) {
  if (topicsEmpty?.parentNode) topicsEmpty.remove()
  topicsData = topics

  if (topics.length === 0) {
    topicListEl.innerHTML = `<div class="empty-panel"><span>no active topics</span></div>`
    return
  }

  const watchTopics = topics.filter(t => t.topic.startsWith('$watch:'))
  const otherTopics = topics.filter(t => !t.topic.startsWith('$watch:'))

  let watchHtml = ''
  if (watchTopics.length > 0) {
    const isGroupExpanded = expandedTopics.has('$watch')
    const childrenHtml = isGroupExpanded
      ? `<div class="topic-children">${watchTopics.map(t => renderTopicEntry(t, t.topic.slice('$watch:'.length))).join('')}</div>`
      : ''
    watchHtml = `
      <div class="topic-entry">
        <div class="topic-row topic-group" data-topic="$watch" data-has-subs="true">
          <span class="tree-chevron topic-chevron" data-topic="$watch">${isGroupExpanded ? CHEVRON_DOWN : CHEVRON_RIGHT}</span>
          <span class="topic-name">$watch</span>
          <span class="topic-sub-count">${watchTopics.length}</span>
        </div>
        ${childrenHtml}
      </div>`
  }

  topicListEl.innerHTML = watchHtml + otherTopics.map(t => renderTopicEntry(t)).join('')
}

topicListEl.addEventListener('click', e => {
  const row = e.target.closest('.topic-row')
  if (!row || row.dataset.hasSubs !== 'true') return
  const topic = row.dataset.topic
  expandedTopics.has(topic) ? expandedTopics.delete(topic) : expandedTopics.add(topic)
  updateTopics(topicsData)
})

clearBtn.addEventListener('click', () => {
  logStream.querySelectorAll('.log-entry').forEach(el => el.remove())
  logCount = 0
  logCountEl.textContent = '0 events'
  if (!logStream.querySelector('.empty-panel')) {
    const empty = document.createElement('div')
    empty.className = 'empty-panel'
    empty.innerHTML = `
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
        <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
      </svg>
      <span>awaiting log events</span>
    `
    logStream.appendChild(empty)
  }
})

// ─── Config ───

const configForm = document.getElementById('config-form')
const saveStatus = document.getElementById('save-status')
const saveError  = document.getElementById('save-error')
const resetBtn   = document.getElementById('reset-btn')

const configDefaults = {
  logPath: 'logs/app.jsonl',
  minLevel: 'debug',
  flushIntervalMs: 3000,
  metricsIntervalMs: 5000,
  metricsEnabled: true,
  model: 'openai/gpt-4o-mini',
  reasoningEnabled: false,
  reasoningEffort: 'medium',
}

function loadConfig() {
  try {
    return { ...configDefaults, ...JSON.parse(localStorage.getItem('rorschach-config') || '{}') }
  } catch { return { ...configDefaults } }
}

function applyToForm(cfg) {
  configForm.logPath.value           = cfg.logPath
  configForm.minLevel.value          = cfg.minLevel
  configForm.flushIntervalMs.value   = cfg.flushIntervalMs
  configForm.metricsIntervalMs.value = cfg.metricsIntervalMs
  configForm.metricsEnabled.checked  = cfg.metricsEnabled
  configForm.model.value             = cfg.model
  configForm.reasoningEnabled.checked = cfg.reasoningEnabled
  configForm.reasoningEffort.value   = cfg.reasoningEffort
}

function readFromForm() {
  return {
    logPath:           configForm.logPath.value.trim(),
    minLevel:          configForm.minLevel.value,
    flushIntervalMs:   Number(configForm.flushIntervalMs.value),
    metricsIntervalMs: Number(configForm.metricsIntervalMs.value),
    metricsEnabled:    configForm.metricsEnabled.checked,
    model:             configForm.model.value,
    reasoningEnabled:  String(configForm.reasoningEnabled.checked),
    reasoningEffort:   configForm.reasoningEffort.value,
  }
}

let saveTimer  = null
let errorTimer = null

function flashSaved() {
  saveError.classList.remove('visible')
  saveStatus.classList.add('visible')
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => saveStatus.classList.remove('visible'), 2200)
}

function flashError(msg) {
  saveStatus.classList.remove('visible')
  saveError.textContent = msg
  saveError.classList.add('visible')
  clearTimeout(errorTimer)
  errorTimer = setTimeout(() => saveError.classList.remove('visible'), 4000)
}

configForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const cfg = readFromForm()
  localStorage.setItem('rorschach-config', JSON.stringify(cfg))
  try {
    const res = await fetch(new URL('config', location.href), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    })
    if (!res.ok) throw new Error(`server error ${res.status}`)
    flashSaved()
  } catch (err) {
    flashError(err.message)
  }
})

resetBtn.addEventListener('click', () => applyToForm(configDefaults))

applyToForm(loadConfig())

// ─── Boot ───
connect()
