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
    } else if (msg.type === 'usage') {
      updateUsageBar(msg)
    } else if (msg.type === 'log') {
      appendLog(msg)
    } else if (msg.type === 'metrics') {
      updateMetrics(msg)
    } else if (msg.type === 'trace') {
      onTraceSpan(msg)
    } else if (msg.type === 'tool_registered') {
      onToolRegistered(msg)
    } else if (msg.type === 'tool_unregistered') {
      onToolUnregistered(msg)
    }
  })
}

// ─── Chat ───

const messagesEl    = document.getElementById('messages')
const emptyEl       = document.getElementById('empty')
const chatForm      = document.getElementById('chat-form')
const input         = document.getElementById('input')
const send          = document.getElementById('send')
const attachBtn     = document.getElementById('attach-btn')
const imageInput    = document.getElementById('image-input')
const imagePreviewsEl = document.getElementById('image-previews')

let pendingImages = []  // array of base64 data URLs

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

// ─── Image upload ───

attachBtn.addEventListener('click', () => imageInput.click())

imageInput.addEventListener('change', async () => {
  const files = Array.from(imageInput.files ?? [])
  for (const file of files) {
    const dataUrl = await readFileAsDataUrl(file)
    pendingImages.push(dataUrl)
  }
  imageInput.value = ''
  renderImagePreviews()
})

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function renderImagePreviews() {
  imagePreviewsEl.innerHTML = ''
  if (pendingImages.length === 0) {
    imagePreviewsEl.classList.add('hidden')
    return
  }
  imagePreviewsEl.classList.remove('hidden')
  pendingImages.forEach((dataUrl, i) => {
    const wrap = document.createElement('div')
    wrap.className = 'image-thumb-wrap'
    const img = document.createElement('img')
    img.src = dataUrl
    img.className = 'image-thumb'
    const removeBtn = document.createElement('button')
    removeBtn.className = 'image-thumb-remove'
    removeBtn.textContent = '×'
    removeBtn.addEventListener('click', () => {
      pendingImages.splice(i, 1)
      renderImagePreviews()
    })
    wrap.appendChild(img)
    wrap.appendChild(removeBtn)
    imagePreviewsEl.appendChild(wrap)
  })
}

function clearPendingImages() {
  pendingImages = []
  renderImagePreviews()
}

chatForm.addEventListener('submit', (e) => {
  e.preventDefault()
  const text = input.value.trim()
  if ((!text && pendingImages.length === 0) || ws?.readyState !== WebSocket.OPEN || isWaiting) return
  appendUserMessage(text, pendingImages.slice())
  ws.send(JSON.stringify({ text, images: pendingImages.slice() }))
  input.value = ''
  input.style.height = 'auto'
  clearPendingImages()
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

function appendUserMessage(text, images) {
  if (emptyEl?.parentNode) emptyEl.remove()
  const wrap   = document.createElement('div')
  wrap.className = 'message user'
  const label  = document.createElement('div')
  label.className = 'message-label'
  label.textContent = 'You'
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
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
  if (text) {
    const textEl = document.createElement('span')
    textEl.textContent = text
    bubble.appendChild(textEl)
  }
  wrap.appendChild(label)
  wrap.appendChild(bubble)
  messagesEl.appendChild(wrap)
  scrollToBottom()
  return wrap
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

function toolActionLabel(toolName) {
  if (toolName === 'web_search') return 'searching the web…'
  if (toolName === 'analyze_image') return 'analysing image…'
  return `running ${toolName}…`
}

function handleChatMsg(msg) {
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

// ─── Usage bar ───

function formatTokens(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function updateUsageBar(msg) {
  document.getElementById('usage-bar').classList.remove('hidden')
  const ctx = msg.contextWindow ? ` · ${Math.round(msg.contextWindow / 1000)}k ctx` : ''
  document.getElementById('usage-model').textContent = msg.model + ctx
  document.getElementById('usage-in').textContent = formatTokens(msg.inputTokens)
  document.getElementById('usage-out').textContent = formatTokens(msg.outputTokens)
  document.getElementById('usage-ctx').textContent = msg.contextPercent != null
    ? `${(msg.contextPercent * 100).toFixed(1)}%`
    : '—'
  document.getElementById('usage-cost').textContent = msg.sessionCost != null
    ? `$${msg.sessionCost.toFixed(4)}`
    : '—'
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
const toolsListEl        = document.getElementById('tools-list')
const toolsEmptyEl       = document.getElementById('tools-empty')
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
  const opLabel = (span.operation === 'tool-invoke' && span.data?.toolName)
    ? `tool-invoke · ${span.data.toolName}`
    : span.operation

  return `
    <div class="waterfall-row" style="padding-left:${8 + depth * 12}px">
      <div class="waterfall-label">
        <span class="wf-actor">${escHtml(actorShort)}</span>
        <span class="wf-op">${escHtml(opLabel)}</span>
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

// ─── Tools ───

const toolsMap = {}

function onToolRegistered(msg) {
  toolsMap[msg.name] = msg.schema
  renderTools()
}

function onToolUnregistered(msg) {
  delete toolsMap[msg.name]
  renderTools()
}

function renderTools() {
  const names = Object.keys(toolsMap).sort()
  toolsListEl.querySelectorAll('.tool-row').forEach(el => el.remove())
  if (names.length === 0) {
    toolsEmptyEl.style.display = ''
    return
  }
  toolsEmptyEl.style.display = 'none'
  for (const name of names) {
    const desc = toolsMap[name]?.function?.description ?? ''
    const row = document.createElement('div')
    row.className = 'tool-row'
    row.innerHTML = `<span class="tool-name">${escHtml(name)}</span><span class="tool-desc">${escHtml(desc)}</span>`
    toolsListEl.appendChild(row)
  }
}

// Observe subtab switching
const obsMemoryControls = document.getElementById('obs-memory-controls')

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
    obsMemoryControls.style.display = subtab === 'memory' ? 'flex' : 'none'
    if (subtab === 'traces') renderTraces()
    if (subtab === 'memory') fetchKgraph()
  })
})

document.getElementById('memory-refresh').addEventListener('click', fetchKgraph)

// ─── Knowledge graph ───

const LABEL_COLORS = {
  Person:     { fill: 'rgba(54,184,204,0.15)',  stroke: '#36b8cc' },
  User:       { fill: 'rgba(69,196,154,0.15)',  stroke: '#45c49a' },
  Project:    { fill: 'rgba(201,150,60,0.15)',  stroke: '#c9963c' },
  Event:      { fill: 'rgba(122,184,204,0.15)', stroke: '#7ab8cc' },
  Preference: { fill: 'rgba(201,95,82,0.15)',   stroke: '#c95f52' },
}
const DEFAULT_NODE_COLOR = { fill: 'rgba(30,63,84,0.4)', stroke: '#2a5468' }

function nodeColor(label)       { return (LABEL_COLORS[label] || DEFAULT_NODE_COLOR).fill }
function nodeColorStroke(label) { return (LABEL_COLORS[label] || DEFAULT_NODE_COLOR).stroke }

async function fetchKgraph() {
  const statsEl = document.getElementById('memory-stats')
  statsEl.textContent = 'loading…'
  try {
    const res = await fetch(new URL('kgraph', location.href))
    const graph = await res.json()
    renderKgraph(graph)
    statsEl.textContent = `${graph.nodes.length} nodes · ${graph.edges.length} edges`
  } catch (e) {
    statsEl.textContent = 'error'
  }
}

function renderKgraph(graph) {
  const container = document.getElementById('memory-graph')
  container.innerHTML = ''

  const { nodes, edges } = graph

  if (nodes.length === 0) {
    container.innerHTML = `<div class="empty-panel"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><circle cx="5" cy="12" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><line x1="7" y1="11.5" x2="17" y2="6.5"/><line x1="7" y1="12.5" x2="17" y2="17.5"/></svg><span>no graph data</span></div>`
    return
  }

  const width  = container.clientWidth
  const height = container.clientHeight
  const R = 22  // node radius

  const simNodes = nodes.map(n => ({ ...n }))
  const nodeById = Object.fromEntries(simNodes.map(n => [n.id, n]))
  const simEdges = edges
    .map(e => ({ ...e, source: nodeById[e.source], target: nodeById[e.target] }))
    .filter(e => e.source && e.target)

  const svg = d3.select(container).append('svg')
    .attr('width', '100%').attr('height', '100%')

  svg.append('defs').append('marker')
    .attr('id', 'kg-arrow')
    .attr('viewBox', '0 -4 8 8')
    .attr('refX', 8).attr('refY', 0)
    .attr('markerWidth', 6).attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', '#2a5468')

  const g = svg.append('g')
  svg.call(d3.zoom().scaleExtent([0.15, 5]).on('zoom', ev => g.attr('transform', ev.transform)))

  const edgeLine = g.append('g').selectAll('line').data(simEdges).enter().append('line')
    .attr('stroke', '#1e3f54').attr('stroke-width', 1.5)
    .attr('marker-end', 'url(#kg-arrow)')

  const edgeLabel = g.append('g').selectAll('text').data(simEdges).enter().append('text')
    .text(d => d.type)
    .attr('font-size', '9px').attr('fill', '#2a5468')
    .attr('text-anchor', 'middle').attr('font-family', 'var(--font-mono)')
    .attr('pointer-events', 'none')

  const tooltip = d3.select(container).append('div').attr('class', 'graph-tooltip').style('display', 'none')

  const nodeGroup = g.append('g').selectAll('g').data(simNodes).enter().append('g')
    .attr('cursor', 'grab')
    .call(d3.drag()
      .on('start', (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y })
      .on('drag',  (ev, d) => { d.fx = ev.x; d.fy = ev.y })
      .on('end',   (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null })
    )

  nodeGroup.append('circle')
    .attr('r', R)
    .attr('fill',         d => nodeColor(d.labels[0]))
    .attr('stroke',       d => nodeColorStroke(d.labels[0]))
    .attr('stroke-width', 1.5)

  nodeGroup.append('text')
    .text(d => String(d.properties.name || d.properties.topic || `#${d.id}`).slice(0, 12))
    .attr('text-anchor', 'middle').attr('dy', '0.35em')
    .attr('font-size', '10px').attr('fill', '#d8eef5')
    .attr('font-family', 'var(--font-mono)').attr('pointer-events', 'none')

  nodeGroup.append('text')
    .text(d => d.labels[0] || '')
    .attr('text-anchor', 'middle').attr('dy', R + 14 + 'px')
    .attr('font-size', '8px').attr('fill', '#3d6878')
    .attr('font-family', 'var(--font-mono)').attr('pointer-events', 'none')

  nodeGroup
    .on('mouseover', (ev, d) => {
      const lines = Object.entries(d.properties).map(([k, v]) => `${k}: ${v}`).join('\n')
      tooltip.style('display', 'block')
        .html(`<strong>${escHtml(d.labels.join(' · '))}</strong><pre>${escHtml(lines)}</pre>`)
    })
    .on('mousemove', ev => {
      const rect = container.getBoundingClientRect()
      tooltip.style('left', (ev.clientX - rect.left + 14) + 'px').style('top', (ev.clientY - rect.top - 14) + 'px')
    })
    .on('mouseout', () => tooltip.style('display', 'none'))

  const sim = d3.forceSimulation(simNodes)
    .force('link',    d3.forceLink(simEdges).id(d => d.id).distance(130))
    .force('charge',  d3.forceManyBody().strength(-320))
    .force('center',  d3.forceCenter(width / 2, height / 2))
    .force('collide', d3.forceCollide(R + 18))
    .on('tick', () => {
      edgeLine
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => {
          const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y
          const dist = Math.sqrt(dx*dx + dy*dy) || 1
          return d.target.x - (dx / dist) * (R + 10)
        })
        .attr('y2', d => {
          const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y
          const dist = Math.sqrt(dx*dx + dy*dy) || 1
          return d.target.y - (dy / dist) * (R + 10)
        })
      edgeLabel
        .attr('x', d => (d.source.x + d.target.x) / 2)
        .attr('y', d => (d.source.y + d.target.y) / 2 - 5)
      nodeGroup.attr('transform', d => `translate(${d.x},${d.y})`)
    })
}


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

// ─── Config tabs ───

const configTabBtns = document.querySelectorAll('[data-config-tab]')
const configPanes   = document.querySelectorAll('[data-config-pane]')

configTabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    configTabBtns.forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    configPanes.forEach(p => p.classList.remove('active'))
    document.querySelector(`[data-config-pane="${btn.dataset.configTab}"]`).classList.add('active')
  })
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
  visionModel: 'google/gemini-flash-1.5',
}

function loadConfig() {
  try {
    return { ...configDefaults, ...JSON.parse(localStorage.getItem('rorschach-config') || '{}') }
  } catch { return { ...configDefaults } }
}

function applyToForm(cfg) {
  configForm.logPath.value            = cfg.logPath
  configForm.minLevel.value           = cfg.minLevel
  configForm.flushIntervalMs.value    = cfg.flushIntervalMs
  configForm.metricsIntervalMs.value  = cfg.metricsIntervalMs
  configForm.metricsEnabled.checked   = cfg.metricsEnabled
  configForm.model.value              = cfg.model
  configForm.reasoningEnabled.checked = cfg.reasoningEnabled
  configForm.reasoningEffort.value    = cfg.reasoningEffort
  configForm.visionModel.value        = cfg.visionModel
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
    visionModel:       configForm.visionModel.value,
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

// ─── Dynamic model list ───

async function initModelSelects() {
  const chatSel   = document.getElementById('chat-model')
  const visionSel = document.getElementById('vision-model')

  chatSel.innerHTML   = '<option value="" disabled>loading models…</option>'
  visionSel.innerHTML = '<option value="" disabled>loading models…</option>'

  let models = []
  try {
    const res = await fetch(new URL('models', location.href))
    if (res.ok) models = await res.json()
  } catch {}

  const cfg = loadConfig()

  for (const [sel, savedVal] of [[chatSel, cfg.model], [visionSel, cfg.visionModel]]) {
    sel.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('')
    if (models.includes(savedVal)) sel.value = savedVal
  }
}

// ─── Boot ───
initModelSelects().then(() => applyToForm(loadConfig()))
connect()
