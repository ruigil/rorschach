import { LightElement, escHtml, defineElement } from './base.js'

const MAX_TRACES = 20

export class RTraceWaterfall extends LightElement {
  constructor() {
    super()
    this._tracesMap = new Map()
  }

  get size() { return this._tracesMap.size }

  addSpan(span) {
    let record = this._tracesMap.get(span.traceId)
    if (!record) {
      if (this._tracesMap.size >= MAX_TRACES) {
        this._tracesMap.delete(this._tracesMap.keys().next().value)
      }
      record = { traceId: span.traceId, requestStart: span.timestamp, spans: new Map() }
      this._tracesMap.set(span.traceId, record)
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
  }

  clear() {
    this._tracesMap.clear()
    this.render()
  }

  render() {
    if (this._tracesMap.size === 0) {
      this.innerHTML = ''
      const e = document.createElement('r-empty-state')
      e.setAttribute('variant', 'panel')
      e.setAttribute('name', 'waterfall')
      e.setAttribute('text', 'awaiting traces')
      this.appendChild(e)
      return
    }
    const arr = Array.from(this._tracesMap.values()).reverse()
    this.innerHTML = arr.map(r => this._renderTrace(r)).join('')
  }

  _computeDepths(spans) {
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

  _renderSpanRow(span, traceStart, totalMs, depth) {
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

  _renderTrace(record) {
    const spans   = Array.from(record.spans.values())
    const now     = Date.now()
    const totalMs = record.requestDuration ?? (now - record.requestStart)
    const isLive  = !record.requestEnd
    const depthMap = this._computeDepths(spans)
    const sorted  = [...spans].sort((a, b) => a.startTime - b.startTime)
    const rows    = sorted.map(s => this._renderSpanRow(s, record.requestStart, totalMs, depthMap.get(s.spanId) ?? 0)).join('')
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
}

defineElement('r-trace-waterfall', RTraceWaterfall)
