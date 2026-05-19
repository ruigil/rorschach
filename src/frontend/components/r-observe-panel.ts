import { html } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { store } from '../store.js';
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
  @state() private _metrics = { actors: 0, recv: 0, done: 0, fail: 0 };
  @state() private _logCountText = '0 events';
  @state() private _tracesCountText = '0 traces';
  @state() private _memoryStatsText = '';

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

  handleMetrics(msg: any) {
    const event = msg;
    const actors: Actor[] = event.actors || [];
    let totRecv = 0;
    let totDone = 0;
    let totFail = 0;
    actors.forEach(a => {
      totRecv += (a as any).messagesReceived  || 0;
      totDone += a.messagesProcessed || 0;
      totFail += (a as any).messagesFailed    || 0;
    });

    if (actors.length > 0) {
      this._metrics = {
        actors: actors.length,
        recv: totRecv,
        done: totDone,
        fail: totFail
      };
      store.set('actors', actors);
    }

    if (this._actorTree) {
      this._actorTree.actors = actors;
    }

    // Update detail if it's showing an actor that was updated
    if (this._actorDetail?.actor) {
      const updated = actors.find(a => a.name === this._actorDetail!.actor!.name);
      if (updated) {
        this._actorDetail.show(updated);
      }
    }
    
    if (event.topics) {
      const topics: Topic[] = event.topics;
      store.set('topics', topics);
      if (this._topicList) {
        this._topicList.topics = topics;
      }
    }
  }

  handleLog(msg: any) {
    const count = this._logStream?.appendEvent(msg) ?? 0;
    this._logCountText = `${count} event${count !== 1 ? 's' : ''}`;
  }

  handleTrace(msg: any) {
    this._tracesList?.addSpan(msg);
    if (this._activeTab === 'traces') {
      this._tracesList?.requestUpdate();
    }
    const size = this._tracesList?.size ?? 0;
    this._tracesCountText = `${size} trace${size !== 1 ? 's' : ''}`;
  }

  handleUsage(msg: any) {
    this._costsTable?.addUsage(msg);
    if (this._activeTab === 'costs') {
      this._costsTable?.requestUpdate();
    }
  }

  handleToolRegistered(msg: any) {
    this._toolsList?.register(msg.name, msg.schema);
  }


  handleToolUnregistered(msg: any) {
    this._toolsList?.unregister(msg.name);
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
    const count = this._logStream?.clear() ?? 0;
    this._logCountText = `${count} events`;
  }

  private _clearTraces() {
    this._tracesList?.clear();
    this._tracesCountText = '0 traces';
  }

  override render() {
    const activeControl = CONTROL_BY_TAB[this._activeTab];
    const showMetrics = activeControl === 'metrics-summary' && this._metrics.actors > 0;

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
              <span class="summary-val">${this._metrics.actors}</span>
              <span class="summary-key">actors</span>
            </div>
            <div class="summary-stat">
              <span class="summary-val">${this._metrics.recv}</span>
              <span class="summary-key">recv</span>
            </div>
            <div class="summary-stat">
              <span class="summary-val">${this._metrics.done}</span>
              <span class="summary-key">done</span>
            </div>
            <div class="summary-stat">
              <span class="summary-val">${this._metrics.fail}</span>
              <span class="summary-key">fail</span>
            </div>
          </div>
          <div class="obs-log-controls" ?hidden=${activeControl !== 'obs-log-controls'}>
            <span class="log-count">${this._logCountText}</span>
            <button class="btn-clear" @click=${this._clearLogs}>clear</button>
          </div>
          <div class="obs-traces-controls" ?hidden=${activeControl !== 'obs-traces-controls'}>
            <span class="log-count">${this._tracesCountText}</span>
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
            <r-actor-tree @actor-select=${this._onActorSelect}></r-actor-tree>
          </div>
          <div class="detail-col">
            <r-actor-detail></r-actor-detail>
          </div>
        </div>
      </div>

      <div class="obs-subpanel ${this._activeTab === 'topics' ? 'active' : ''}">
        <r-topic-list .topics=${store.get('topics')}></r-topic-list>
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
    `;  }
}
