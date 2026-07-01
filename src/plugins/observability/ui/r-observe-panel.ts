import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { RorschachBase } from '@rorschach/frontend/webkit/base.js';
import { store } from '@rorschach/frontend/webkit/store.js';
import { StoreController } from '@rorschach/frontend/webkit/store-controller.js';
import type { Actor, Topic, LogEvent, TraceSpan, ShellState } from '../../../frontend/types/state.js';
import '@rorschach/frontend/webkit/r-panel.js';
import '@rorschach/frontend/webkit/r-tabs.js';
import '@rorschach/frontend/webkit/r-empty-state.js';
import '@rorschach/frontend/webkit/r-actor-tree.js';
import '@rorschach/frontend/webkit/r-actor-detail.js';
import '@rorschach/frontend/webkit/r-topic-list.js';
import '@rorschach/frontend/webkit/r-log-stream.js';
import '@rorschach/frontend/webkit/r-trace-waterfall.js';
import '@rorschach/frontend/webkit/r-costs-table.js';
import '@rorschach/frontend/webkit/r-toolbar.js';
import { OBSERVE_TABS, DEFAULT_OBSERVE_TAB } from '../../../frontend/constants.js';
import type { ObserveTab } from '../../../frontend/constants.js';

const CONTROL_BY_TAB: Record<ObserveTab, string> = {
  metrics: 'metrics-summary',
  logs:    'obs-log-controls',
  traces:  'obs-traces-controls',
  memory:  'obs-memory-controls',
  topics:  '',
  tools:   '',
  costs:   '',
};

const shell = () => store.namespace<ShellState>('shell')

@customElement('r-observe-panel')
export class RObservePanel extends RorschachBase {
  @state() private _memoryStatsText = '';
  @state() private _kgData: any = null;
  @state() private _selectedActor: Actor | null = null;

  private _observeActiveTab = new StoreController(this, ['shell', 'observeActiveTab']);
  private _actors = new StoreController(this, ['shell', 'actors']);
  private _topics = new StoreController(this, ['shell', 'topics']);
  private _logs = new StoreController(this, ['shell', 'logs']);
  private _traces = new StoreController(this, ['shell', 'traces']);

  static override styles = css`
    :host {
      display: block;
      height: 100%;
      width: 100%;
    }

    [hidden] {
      display: none !important;
    }

    /* ─── Observe panel ─── */
    .obs-bar-end {
      display: flex;
      align-items: center;
      gap: 1.25rem;
    }

    .metrics-summary {
      display: flex;
      align-items: center;
      gap: 1.25rem;
    }

    .summary-stat {
      display: flex;
      flex-direction: row;
      align-items: baseline;
      gap: 0.35rem;
    }

    .summary-val {
      font-size: 0.82rem;
      font-weight: 700;
      font-family: var(--font-mono);
      color: var(--text);
    }

    .summary-key {
      font-size: 0.55rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--text-dim);
    }

    .obs-log-controls,
    .obs-traces-controls {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    /* ─── Subpanels ─── */
    .obs-subpanel {
      display: none;
      flex: 1;
      overflow: hidden;
      min-height: 0;
    }

    .obs-subpanel.active { display: flex; flex-direction: column; }

    /* ─── Metrics layout ─── */
    .metrics-layout {
      display: grid;
      grid-template-columns: 240px 1fr;
      flex: 1;
      overflow: hidden;
      min-height: 0;
    }

    .tree-col {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border-right: 1px solid var(--border);
    }

    .detail-col {
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ─── Log controls ─── */
    .log-count { font-size: 0.62rem; font-family: var(--font-mono); color: var(--text-dim); }

    .btn-clear {
      font-size: 0.62rem;
      font-weight: 500;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-dim);
      background: none;
      border: 1px solid var(--border-mid);
      border-radius: 4px;
      padding: 0.2rem 0.55rem;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
      font-family: var(--font-ui);
    }

    .btn-clear:hover { color: var(--text-mid); border-color: var(--text-dim); }

    /* ─── Topics subpanel ─── */
    r-topic-list {
      flex: 1;
      overflow-y: auto;
      padding: 0.4rem 0;
    }

    r-topic-list::-webkit-scrollbar { width: 3px; }
    r-topic-list::-webkit-scrollbar-track { background: transparent; }
    r-topic-list::-webkit-scrollbar-thumb { background: var(--border-mid); border-radius: 2px; }

    /* ─── Tools panel ─── */
    r-tools-list {
      flex: 1;
      overflow-y: auto;
      padding: 0.75rem;
    }

    r-tools-list::-webkit-scrollbar { width: 3px; }
    r-tools-list::-webkit-scrollbar-track { background: transparent; }
    r-tools-list::-webkit-scrollbar-thumb { background: var(--border-mid); border-radius: 2px; }

    /* ─── Traces container ─── */
    [data-observe-tab="traces"] {
      overflow-y: auto;
      padding: 12px 12px 0 12px;
      box-sizing: border-box;
    }

    /* ─── Memory controls ─── */
    .obs-memory-controls {
      display: flex;
      align-items: center;
      gap: 10px;
    }
  `;

  override updated(changedProperties: Map<string, any>) {
    const tab = this._observeActiveTab.value;
    if (tab === 'memory' && !this._kgData) {
      this._fetchKgraph();
    }
  }

  private _onTabChange(event: CustomEvent) {
    const tab = event.detail?.tab;
    if (!tab) return;
    shell().set('observeActiveTab', tab);
  }

  private _onActorSelect(event: CustomEvent) {
    this._selectedActor = event.detail.actor;
  }

  private async _fetchKgraph() {
    this._memoryStatsText = 'loading...';
    try {
      const res = await fetch(new URL('kgraph', location.href));
      const graph = await res.json();
      this._kgData = graph;
      this._memoryStatsText = `${graph.nodes.length} nodes · ${graph.edges.length} edges`;
    } catch {
      this._memoryStatsText = 'error';
    }
  }

  private _clearLogs() {
    shell().set('logs', []);
  }

  private _clearTraces() {
    shell().set('traces', []);
  }

  override render() {
    const activeTab = this._observeActiveTab.value || DEFAULT_OBSERVE_TAB;
    const activeControl = CONTROL_BY_TAB[activeTab];
    const actors = this._actors.value;
    const topics = this._topics.value;
    const logs = this._logs.value;
    const traces = this._traces.value;

    let totRecv = 0, totDone = 0, totFail = 0;
    actors.forEach((a: any) => {
      totRecv += a.messagesReceived  || 0;
      totDone += a.messagesProcessed || 0;
      totFail += a.messagesFailed    || 0;
    });

    const showMetrics = activeControl === 'metrics-summary' && actors.length > 0;
    const logCountText = `${logs.length} event${logs.length !== 1 ? 's' : ''}`;
    const tracesCountText = `${traces.length} trace${traces.length !== 1 ? 's' : ''}`;

    return html`
      <r-panel elevation="1">
        <r-toolbar slot="header-container">
          <r-tabs @tab-change=${this._onTabChange}>
            <button ?active=${activeTab === 'metrics'} data-subtab="metrics">metrics</button>
            <button ?active=${activeTab === 'topics'} data-subtab="topics">topics</button>
            <button ?active=${activeTab === 'logs'} data-subtab="logs">logs</button>
            <button ?active=${activeTab === 'traces'} data-subtab="traces">traces</button>
            <button ?active=${activeTab === 'tools'} data-subtab="tools">tools</button>
            <button ?active=${activeTab === 'memory'} data-subtab="memory">memory</button>
            <button ?active=${activeTab === 'costs'} data-subtab="costs">costs</button>
          </r-tabs>
          <div slot="actions" class="obs-bar-end">
            <div class="metrics-summary" ?hidden=${!showMetrics}>
              <div class="summary-stat">
                <span class="summary-val">${actors.length}</span>
                <span class="summary-key">actors</span>
              </div>
              <div class="summary-stat">
                <span class="summary-val">${totRecv}</span>
                <span class="summary-key">recv</span>
              </div>
              <div class="summary-stat">
                <span class="summary-val">${totDone}</span>
                <span class="summary-key">done</span>
              </div>
              <div class="summary-stat">
                <span class="summary-val">${totFail}</span>
                <span class="summary-key">fail</span>
              </div>
            </div>
            <div class="obs-log-controls" ?hidden=${activeControl !== 'obs-log-controls'}>
              <span class="log-count">${logCountText}</span>
              <button class="btn-clear" @click=${this._clearLogs}>clear</button>
            </div>
            <div class="obs-traces-controls" ?hidden=${activeControl !== 'obs-traces-controls'}>
              <span class="log-count">${tracesCountText}</span>
              <button class="btn-clear" @click=${this._clearTraces}>clear</button>
            </div>
            <div class="obs-memory-controls" ?hidden=${activeControl !== 'obs-memory-controls'}>
              <span class="log-count">${this._memoryStatsText}</span>
              <button class="btn-clear" @click=${this._fetchKgraph}>refresh</button>
            </div>
          </div>
        </r-toolbar>

        <div style="flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; height: 100%;">
          <div class="obs-subpanel ${activeTab === 'metrics' ? 'active' : ''}" data-observe-tab="metrics">
            <div class="metrics-layout">
              <div class="tree-col">
                <r-actor-tree .actors=${actors} @actor-select=${this._onActorSelect}></r-actor-tree>
              </div>
              <div class="detail-col">
                <r-actor-detail .actor=${this._selectedActor}></r-actor-detail>
              </div>
            </div>
          </div>

          <div class="obs-subpanel ${activeTab === 'topics' ? 'active' : ''}" data-observe-tab="topics">
            <r-topic-list .topics=${topics}></r-topic-list>
          </div>

          <div class="obs-subpanel ${activeTab === 'traces' ? 'active' : ''}" data-observe-tab="traces">
            <r-trace-waterfall></r-trace-waterfall>
          </div>

          <div class="obs-subpanel ${activeTab === 'logs' ? 'active' : ''}" data-observe-tab="logs">
            <r-log-stream></r-log-stream>
          </div>

          <div class="obs-subpanel ${activeTab === 'tools' ? 'active' : ''}" data-observe-tab="tools">
            <r-tools-list></r-tools-list>
          </div>

          <r-costs-table class="obs-subpanel ${activeTab === 'costs' ? 'active' : ''}" data-observe-tab="costs">
          </r-costs-table>

          <div class="obs-subpanel ${activeTab === 'memory' ? 'active' : ''}" data-observe-tab="memory">
            <r-force-graph .kgData=${this._kgData}></r-force-graph>
          </div>
        </div>
      </r-panel>
    `;
  }
}
