import {
  css,
  customElement,
  html,
  RorschachBase,
  state,
  store,
  StoreController,
  send,
  workspaceStyles,
  type TreeNode
} from '@rorschach/webkit';


import type { ObservabilityState } from './index.js';
import './r-costs-table.js';
import './r-actor-tree.js';
import './r-actor-detail.js';
import './r-tools-list.js';
import './r-agents-list.js';
import './r-topic-list.js';
import './r-trace-waterfall.js';
import type { Actor } from '../types.js';

export const OBSERVE_TABS = ['metrics', 'topics', 'logs', 'traces', 'tools', 'agents', 'memory', 'costs'] as const;
export type ObserveTab = typeof OBSERVE_TABS[number];
export const DEFAULT_OBSERVE_TAB: ObserveTab = 'metrics';

const TAB_LABELS: Record<ObserveTab, string> = {
  metrics: 'Metrics',
  topics:  'Topics',
  logs:    'Logs',
  traces:  'Traces',
  tools:   'Tools',
  agents:  'Agents',
  memory:  'Memory Graph',
  costs:   'Usage Costs',
};

const CONTROL_BY_TAB: Record<ObserveTab, string> = {
  metrics: 'metrics-summary',
  logs:    'obs-log-controls',
  traces:  'obs-traces-controls',
  memory:  'obs-memory-controls',
  topics:  '',
  tools:   '',
  agents:  '',
  costs:   '',
};

const observe = () => store.namespace<ObservabilityState>('observe')

@customElement('r-observe-panel')
export class RObservePanel extends RorschachBase {
  @state() private _selectedActor: Actor | null = null;

  @state() private _observeActiveTab: ObserveTab = 'metrics';
  private _actors = new StoreController(this, ['observe', 'actors']);
  private _topics = new StoreController(this, ['observe', 'topics']);
  private _logs = new StoreController(this, ['observe', 'logs']);
  private _traces = new StoreController(this, ['observe', 'traces']);
  private _tools = new StoreController(this, ['observe', 'tools']);
  private _agents = new StoreController(this, ['observe', 'agents']);
  private _kgDataController = new StoreController(this, ['observe', 'kgraph']);

  static override styles = [
    workspaceStyles,
    css`
      :host {
        display: block;
        height: 100%;
        width: 100%;
      }

      [hidden] {
        display: none !important;
      }


    .obs-header-title-container {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      height: 100%;
    }

    .obs-title-base {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-dim);
      font-family: var(--font-ui);
    }

    .obs-title-sep {
      font-size: 0.75rem;
      color: var(--text-dim);
      opacity: 0.5;
    }

    .obs-title-active {
      font-size: 0.72rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--accent);
      background: var(--accent-dim);
      padding: 0.15rem 0.5rem;
      border-radius: 4px;
      border: 1px solid var(--accent-glow);
      font-family: var(--font-ui);
    }

    /* ─── Body Layout (Below Toolbar) ─── */
    .obs-body {
      display: grid;
      grid-template-columns: 220px 1fr;
      flex: 1;
      min-height: 0;
      overflow: hidden;
      width: 100%;
      height: 100%;
    }

    /* ─── Coherent App Sidebar ─── */
    .obs-sidebar {
      display: flex;
      flex-direction: column;
      background: var(--sidebar-bg, var(--surface));
      border-right: 1px solid var(--border);
      overflow: hidden;
      user-select: none;
    }

    .obs-sidebar-tree {
      flex: 1;
      overflow-y: auto;
      padding: 0.5rem 0.35rem;
    }

    .obs-sidebar-tree::-webkit-scrollbar { width: 3px; }
    .obs-sidebar-tree::-webkit-scrollbar-track { background: transparent; }
    .obs-sidebar-tree::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 2px; }

    /* ─── Right Main Workspace (No subheader) ─── */
    .obs-main {
      display: flex;
      flex-direction: column;
      flex: 1;
      height: 100%;
      overflow: hidden;
      min-width: 0;
      background: var(--bg);
    }

    /* ─── Observe panel controls ─── */
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
    }
  `
];

  override updated(changedProperties: Map<string, any>) {
    const tab = this._observeActiveTab;
    if (tab === 'memory' && !this._kgDataController.value) {
      this._requestKgraph();
    }
  }

  private get _treeData(): TreeNode[] {
    const actors = this._actors.value ?? [];
    const logs = this._logs.value ?? [];
    const traces = this._traces.value ?? [];
    const topics = this._topics.value ?? [];
    const toolsObj = this._tools.value ?? {};
    const toolsCount = Object.keys(toolsObj).length;
    const agents = this._agents.value ?? [];
    const graph = this._kgDataController.value;

    return [
      {
        id: 'cat-telemetry',
        label: 'Telemetry',
        icon: 'folder',
        children: [
          { id: 'metrics', label: 'Metrics', icon: 'activity', badge: actors.length || undefined },
          { id: 'logs', label: 'Logs', icon: 'file-text', badge: logs.length || undefined },
          { id: 'traces', label: 'Traces', icon: 'waterfall', badge: traces.length || undefined },
        ],
      },
      {
        id: 'cat-components',
        label: 'Components',
        icon: 'folder',
        children: [
          { id: 'topics', label: 'Topics', icon: 'git-branch', badge: topics.length || undefined },
          { id: 'tools', label: 'Tools', icon: 'wrench', badge: toolsCount || undefined },
          { id: 'agents', label: 'Agents', icon: 'user', badge: agents.length || undefined },
        ],
      },
      {
        id: 'cat-state',
        label: 'State & Analytics',
        icon: 'folder',
        children: [
          { id: 'memory', label: 'Memory Graph', icon: 'brain', badge: graph ? `${graph.nodes?.length ?? 0}n` : undefined },
          { id: 'costs', label: 'Usage Costs', icon: 'circle' },
        ],
      },
    ];
  }

  private _onNodeSelect(event: CustomEvent<{ node: TreeNode }>) {
    const selectedId = event.detail?.node?.id;
    if (selectedId && OBSERVE_TABS.includes(selectedId as ObserveTab)) {
      const tab = selectedId as ObserveTab;
      this._observeActiveTab = tab;
      observe().set('activeTab', tab);
    }
  }

  private _onActorSelect(event: CustomEvent) {
    this._selectedActor = event.detail.actor;
  }

  private _requestKgraph() {
    send({ type: 'memory.kgraph.request' });
  }

  private _clearLogs() {
    observe().set('logs', []);
  }

  private _clearTraces() {
    observe().set('traces', []);
  }

  override render() {
    const activeTab = this._observeActiveTab;
    const activeControl = CONTROL_BY_TAB[activeTab];
    const activeTabLabel = TAB_LABELS[activeTab] ?? activeTab;

    const actors = this._actors.value ?? [];
    const topics = this._topics.value ?? [];
    const logs = this._logs.value ?? [];
    const traces = this._traces.value ?? [];

    let totRecv = 0, totDone = 0, totFail = 0;
    actors.forEach((a: any) => {
      totRecv += a.messagesReceived  || 0;
      totDone += a.messagesProcessed || 0;
      totFail += a.messagesFailed    || 0;
    });

    const showMetrics = activeControl === 'metrics-summary' && actors.length > 0;
    const logCountText = `${logs.length} event${logs.length !== 1 ? 's' : ''}`;
    const tracesCountText = `${traces.length} trace${traces.length !== 1 ? 's' : ''}`;

    const graph = this._kgDataController.value;
    const statsText = graph ? `${graph.nodes.length} nodes · ${graph.edges.length} edges` : 'loading...';

    return html`
      <r-panel elevation="1" style="height: 100%; display: flex; flex-direction: column;">
        <r-toolbar slot="header-container">
          <div class="ws-header-title">
            <span class="ws-title-base">Observability</span>
            <span class="ws-title-sep">/</span>
            <span class="ws-title-active">${activeTabLabel}</span>
          </div>
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
              <span class="log-count">${statsText}</span>
            </div>
          </div>
        </r-toolbar>

        <div class="ws-body">
          <aside class="ws-sidebar">
            <div class="ws-sidebar-tree">
              <r-tree
                .data=${this._treeData}
                .selectedId=${activeTab}
                @node-select=${this._onNodeSelect}
              ></r-tree>
            </div>
          </aside>

          <main class="ws-main">
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

            <div class="obs-subpanel ${activeTab === 'agents' ? 'active' : ''}" data-observe-tab="agents">
              <r-agents-list></r-agents-list>
            </div>

            <r-costs-table class="obs-subpanel ${activeTab === 'costs' ? 'active' : ''}" data-observe-tab="costs">
            </r-costs-table>

            <div class="obs-subpanel ${activeTab === 'memory' ? 'active' : ''}" data-observe-tab="memory">
              <r-force-graph .kgData=${graph}></r-force-graph>
            </div>
          </main>
        </div>
      </r-panel>
    `;
  }
}



