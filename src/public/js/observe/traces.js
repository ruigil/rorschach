import { escHtml } from '../utils.js'

const tracesCountEl  = document.getElementById('traces-count')
const clearTracesBtn = document.getElementById('clear-traces')
const tracesListEl   = document.getElementById('obs-traces-list')

// Map<traceId, { traceId, requestStart, requestEnd?, requestDuration?, spans: Map<spanId, SpanData> }>
const tracesMap = new Map()
const MAX_TRACES = 20

export function onTraceSpan(span) {
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
      spanId:       span.spanId,
      parentSpanId: span.parentSpanId,
      actor:        span.actor,
      operation:    span.operation,
      startTime:    span.timestamp,
      status:       span.status,
      data:         span.data,
    }
    record.spans.set(span.spanId, spanData)
  } else {
    spanData.endTime    = span.timestamp
    spanData.durationMs = span.durationMs
    spanData.status     = span.status
    if (span.data) spanData.data = Object.assign({}, spanData.data, span.data)
  }

  if (span.operation === 'request' && (span.status === 'done' || span.status === 'error')) {
    record.requestDuration = span.durationMs
    record.requestEnd      = span.timestamp
  }

  if (document.querySelector('.obs-subtab[data-subtab="traces"].active')) {
    renderTraces()
  }
  tracesCountEl.textContent = `${tracesMap.size} trace${tracesMap.size !== 1 ? 's' : ''}`
}

function computeDepths(spans) {
  const depthMap = new Map()
  const spanMap  = new Map(spans.map(s => [s.spanId, s]))
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
  const offset   = Math.max(0, ((span.startTime - traceStart) / totalMs) * 100)
  const duration = span.durationMs ?? (Date.now() - span.startTime)
  const width    = Math.max(0.5, Math.min(100 - offset, (duration / totalMs) * 100))
  const isActive = span.status === 'started'
  const isError  = span.status === 'error'
  const opClass  = 'op-' + span.operation.replace(/[^a-z0-9]/g, '-')
  const dur      = span.durationMs != null ? span.durationMs + 'ms' : '…'
  const actorShort = span.actor.split('/').pop() ?? span.actor
  const opLabel  = (span.operation === 'tool-invoke' && span.data?.toolName)
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
  const spans   = Array.from(record.spans.values())
  const now     = Date.now()
  const totalMs = record.requestDuration ?? (now - record.requestStart)
  const isLive  = !record.requestEnd
  const depthMap = computeDepths(spans)
  const sorted  = [...spans].sort((a, b) => a.startTime - b.startTime)
  const rows    = sorted.map(s => renderSpanRow(s, record.requestStart, totalMs, depthMap.get(s.spanId) ?? 0)).join('')
  const durStr  = record.requestDuration != null ? record.requestDuration + 'ms' : '…'
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

export function renderTraces() {
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
