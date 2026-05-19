import { html } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { store, StoreController } from '../store.js';
import { RActorTree } from './r-actor-tree.js';
import { RActorDetail } from './r-actor-detail.js';
import { RTopicList } from './r-topic-list.js';
import { RLogStream } from './r-log-stream.js';
import { RTraceWaterfall } from './r-trace-waterfall.js';
import { RToolsList } from './r-tools-list.js';
import { RCostsTable } from './r-costs-table.js';
import { RForceGraph } from './r-force-graph.js';
import type { Topic, Actor } from '../types/state.js';

const CONTROL_BY_TAB: Record<string, string> = {
  metrics: 'metrics-summary',
  logs:    'obs-log-controls',
  traces:  'obs-traces-controls',
  memory:  'obs-memory-controls',
};

@customElement('r-observe-panel')
export class RObservePanel extends RorschachBase {
  @state() private _activeTab = 'metrics';
  @state() private _memoryStatsText = '';

  private _actors = new StoreController(this, 'actors');
  private _topics = new StoreController(this, 'topics');
  private _logs = new StoreController(this, 'logs');
  private _traces = new StoreController(this, 'traces');

  @query('r-actor-tree') private _actorTree?: RActorTree;
  @query('r-actor-detail') private _actorDetail?: RActorDetail;
  @query('r-topic-list') private _topicList?: RTopicList;
  @query('r-log-stream') private _logStream?: RLogStream;
  @query('r-trace-waterfall') private _tracesList?: RTraceWaterfall;
  @query('r-tools-list') private _toolsList?: RToolsList;
  @query('r-costs-table') private _costsTable?: RCostsTable;
  @query('r-force-graph') private _memoryGraph?: RForceGraph;

  // Render to light DOM to reuse shell styles
  override createRenderRoot() {
    return this;
  }

  private _onTabChange(event: CustomEvent) {
    const tab = event.detail?.tab;
    if (!tab) return;
    this._activeTab = tab;

    if (tab === 'traces') this._tracesList?.requestUpdate();
    if (tab === 'memory') this._fetchKgraph();
    if (tab === 'costs') this._costsTable?.requestUpdate();
  }

  private _onActorSelect(event: CustomEvent) {
    this._actorDetail?.show(event.detail.actor);
  }

  private async _fetchKgraph() {
    this._memoryStatsText = 'loading...';
    try {
      const res = await fetch(new URL('kgraph', location.href));
      const graph = await res.json();
      this._memoryGraph?.renderKnowledgeGraph(graph);
      this._memoryStatsText = `${graph.nodes.length} nodes · ${graph.edges.length} edges`;
    } catch {
      this._memoryStatsText = 'error';
    }
  }

  private _clearLogs() {
    store.set('logs', []);
  }

  private _clearTraces() {
    store.set('traces', []);
  }

  override render() {
    const activeControl = CONTROL_BY_TAB[this._activeTab];
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
      <div class="obs-bar">
        <r-tabs class="obs-subtabs" @tab-change=${this._onTabChange}>
          <button class="obs-subtab ${this._activeTab === 'metrics' ? 'active' : ''}" data-subtab="metrics">metrics</button>
          <button class="obs-subtab ${this._activeTab === 'topics' ? 'active' : ''}" data-subtab="topics">topics</button>
          <button class="obs-subtab ${this._activeTab === 'logs' ? 'active' : ''}" data-subtab="logs">logs</button>
          <button class="obs-subtab ${this._activeTab === 'traces' ? 'active' : ''}" data-subtab="traces">traces</button>
          <button class="obs-subtab ${this._activeTab === 'tools' ? 'active' : ''}" data-subtab="tools">tools</button>
          <button class="obs-subtab ${this._activeTab === 'memory' ? 'active' : ''}" data-subtab="memory">memory</button>
          <button class="obs-subtab ${this._activeTab === 'costs' ? 'active' : ''}" data-subtab="costs">costs</button>
        </r-tabs>
        <div class="obs-bar-end">
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
      </div>

      <div class="obs-subpanel ${this._activeTab === 'metrics' ? 'active' : ''}">
        <div class="metrics-layout">
          <div class="tree-col">
            <r-actor-tree .actors=${actors} @actor-select=${this._onActorSelect}></r-actor-tree>
          </div>
          <div class="detail-col">
            <r-actor-detail></r-actor-detail>
          </div>
        </div>
      </div>

      <div class="obs-subpanel ${this._activeTab === 'topics' ? 'active' : ''}">
        <r-topic-list .topics=${topics}></r-topic-list>
      </div>

      <div class="obs-subpanel ${this._activeTab === 'traces' ? 'active' : ''}">
        <r-trace-waterfall></r-trace-waterfall>
      </div>

      <div class="obs-subpanel ${this._activeTab === 'logs' ? 'active' : ''}">
        <r-log-stream></r-log-stream>
      </div>

      <div class="obs-subpanel ${this._activeTab === 'tools' ? 'active' : ''}">
        <r-tools-list></r-tools-list>
      </div>

      <r-costs-table class="obs-subpanel ${this._activeTab === 'costs' ? 'active' : ''}">
      </r-costs-table>

      <div class="obs-subpanel ${this._activeTab === 'memory' ? 'active' : ''}">
        <r-force-graph></r-force-graph>
      </div>
    `;
  }
}

