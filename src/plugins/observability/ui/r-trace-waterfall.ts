import {
  css,
  customElement,
  html,
  RorschachBase,
  state,
  type TemplateResult,
  store,
  StoreController
} from '@rorschach/webkit';

import type { TraceSpan } from '../types.js';
import type { ObservabilityState } from './index.js';

const MAX_TRACES = 20;

type TraceSpanRecord = {
  spanId: string;
  parentSpanId: string | null;
  actor: string;
  operation: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: string;
  data?: any;
};

type TraceRecord = {
  traceId: string;
  requestStart: number;
  requestEnd?: number;
  requestDuration?: number;
  spans: Map<string, TraceSpanRecord>;
};

@customElement('r-trace-waterfall')
export class RTraceWaterfall extends RorschachBase {
  private _traces = new StoreController(this, ['observe', 'traces']);

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
    }
    .trace-item {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }
    .trace-item.wf-live {
      border-color: var(--accent);
    }
    .trace-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.35rem 0.75rem;
      background: var(--surface-2);
      border-bottom: 1px solid var(--border);
      font-family: var(--font-mono);
      font-size: 0.7rem;
    }
    .trace-id   { color: var(--text-dim); }
    .trace-dur  { color: var(--accent); margin-left: auto; }
    .trace-live-badge {
      color: var(--accent);
      font-size: 0.62rem;
      padding: 1px 5px;
      border: 1px solid var(--accent-glow);
      border-radius: 3px;
      animation: wf-pulse-text 1.2s ease-in-out infinite;
    }
    @keyframes wf-pulse-text {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.35; }
    }
    .trace-waterfall {
      display: flex;
      flex-direction: column;
      gap: 1px;
      padding: 0.3rem 0;
    }
    .waterfall-row {
      display: grid;
      grid-template-columns: 150px 1fr 44px;
      align-items: center;
      gap: 0.5rem;
      padding: 2px 0.6rem 2px 0;
      font-family: var(--font-mono);
      font-size: 0.67rem;
    }
    .waterfall-label {
      display: flex;
      flex-direction: column;
      gap: 1px;
      overflow: hidden;
    }
    .wf-actor { color: var(--text-mid); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .wf-op    { color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .waterfall-track {
      position: relative;
      height: 12px;
      background: var(--surface-2);
      border-radius: 3px;
      overflow: hidden;
    }
    .waterfall-bar {
      position: absolute;
      top: 0;
      height: 100%;
      border-radius: 3px;
      min-width: 2px;
    }
    .waterfall-bar.op-request        { background: var(--accent-dim);              border: 1px solid var(--accent);                    }
    .waterfall-bar.op-llm-call        { background: rgba(139,92,246,0.2);           border: 1px solid rgba(139,92,246,0.55);            }
    .waterfall-bar.op-tool-invoke     { background: rgba(245,158,11,0.18);          border: 1px solid rgba(245,158,11,0.5);             }
    .waterfall-bar.op-brave-search    { background: rgba(245,158,11,0.18);          border: 1px solid rgba(245,158,11,0.5);             }
    .waterfall-bar.wf-active { animation: wf-pulse-bar 1s ease-in-out infinite; }
    .waterfall-bar.wf-error  { background: var(--error-bg) !important; border-color: var(--error) !important; }
    @keyframes wf-pulse-bar {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.5; }
    }
    .waterfall-dur {
      color: var(--text-dim);
      text-align: right;
      white-space: nowrap;
    }
  `;

  get size() {
    const tracesMap = this._getTracesMap();
    return tracesMap.size;
  }

  private _getTracesMap() {
    const traces = this._traces.value;
    const tracesMap = new Map<string, TraceRecord>();

    traces.forEach(span => {
      let record = tracesMap.get(span.traceId);
      if (!record) {
        if (tracesMap.size >= MAX_TRACES) {
          const oldestId = tracesMap.keys().next().value;
          if (oldestId) tracesMap.delete(oldestId);
        }
        record = { traceId: span.traceId, requestStart: span.timestamp, spans: new Map() };
        tracesMap.set(span.traceId, record);
      }

      let spanData = record.spans.get(span.spanId);
      if (!spanData) {
        spanData = {
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
          actor: span.actor,
          operation: span.operation,
          startTime: span.timestamp,
          status: span.status,
          data: span.data,
        };
        record.spans.set(span.spanId, spanData);
      } else {
        spanData.endTime = span.timestamp;
        spanData.durationMs = span.durationMs;
        spanData.status = span.status;
        if (span.data) {
          spanData.data = { ...spanData.data, ...span.data };
        }
      }

      if (span.operation === 'request' && (span.status === 'done' || span.status === 'error')) {
        record.requestDuration = span.durationMs;
        record.requestEnd = span.timestamp;
      }
    });

    return tracesMap;
  }

  clear() {
    store.namespace<ObservabilityState>('observe').set('traces', []);
  }

  private _computeDepths(spans: TraceSpanRecord[]): Map<string, number> {
    const depthMap = new Map<string, number>();
    const spanMap = new Map(spans.map(s => [s.spanId, s]));
    
    const getDepth = (span: TraceSpanRecord): number => {
      if (depthMap.has(span.spanId)) return depthMap.get(span.spanId)!;
      if (!span.parentSpanId) {
        depthMap.set(span.spanId, 0);
        return 0;
      }
      const parent = spanMap.get(span.parentSpanId);
      const d = parent ? getDepth(parent) + 1 : 0;
      depthMap.set(span.spanId, d);
      return d;
    };

    spans.forEach(s => getDepth(s));
    return depthMap;
  }

  private _renderSpanRow(span: TraceSpanRecord, traceStart: number, totalMs: number, depth: number): TemplateResult {
    const offset = Math.max(0, ((span.startTime - traceStart) / totalMs) * 100);
    const duration = span.durationMs ?? (Date.now() - span.startTime);
    const width = Math.max(0.5, Math.min(100 - offset, (duration / totalMs) * 100));
    const isActive = span.status === 'started';
    const isError = span.status === 'error';
    const opClass = 'op-' + span.operation.replace(/[^a-z0-9]/g, '-');
    const dur = span.durationMs != null ? span.durationMs + 'ms' : '…';
    const actorShort = span.actor.split('/').pop() ?? span.actor;
    const opLabel = (span.operation === 'tool-invoke' && span.data?.toolName)
      ? `tool-invoke · ${span.data.toolName}`
      : span.operation;

    return html`
      <div class="waterfall-row" style="padding-left:${8 + depth * 12}px">
        <div class="waterfall-label">
          <span class="wf-actor">${actorShort}</span>
          <span class="wf-op">${opLabel}</span>
        </div>
        <div class="waterfall-track">
          <div 
            class="waterfall-bar ${opClass} ${isActive ? 'wf-active' : ''} ${isError ? 'wf-error' : ''}"
            style="left:${offset.toFixed(1)}%;width:${width.toFixed(1)}%"
          ></div>
        </div>
        <div class="waterfall-dur">${dur}</div>
      </div>
    `;
  }

  private _renderTrace(record: TraceRecord): TemplateResult {
    const spans = Array.from(record.spans.values());
    const now = Date.now();
    const totalMs = record.requestDuration ?? (now - record.requestStart);
    const isLive = !record.requestEnd;
    const depthMap = this._computeDepths(spans);
    const sorted = [...spans].sort((a, b) => a.startTime - b.startTime);
    const rows = sorted.map(s => this._renderSpanRow(s, record.requestStart, totalMs, depthMap.get(s.spanId) ?? 0));
    const durStr = record.requestDuration != null ? record.requestDuration + 'ms' : '…';
    const traceIdShort = record.traceId.slice(-10);

    return html`
      <div class="trace-item ${isLive ? 'wf-live' : ''}">
        <div class="trace-header">
          <span class="trace-id">${traceIdShort}</span>
          <span class="trace-dur">${durStr}</span>
          ${isLive ? html`<span class="trace-live-badge">live</span>` : ''}
        </div>
        <div class="trace-waterfall">${rows}</div>
      </div>
    `;
  }

  override render() {
    const tracesMap = this._getTracesMap();
    if (tracesMap.size === 0) {
      return html`
        <r-empty-state 
          variant="panel" 
          name="waterfall" 
          text="awaiting traces"
        ></r-empty-state>
      `;
    }

    const arr = Array.from(tracesMap.values()).reverse();
    return html`${arr.map(r => this._renderTrace(r))}`;
  }
}
