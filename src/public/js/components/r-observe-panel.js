import { LightElement, defineElement } from './base.js'

const CONTROL_BY_TAB = {
  metrics: 'metrics-summary',
  logs:    'obs-log-controls',
  traces:  'obs-traces-controls',
  memory:  'obs-memory-controls',
}

export class RObservePanel extends LightElement {
  constructor() {
    super()
    this._activeTab = 'metrics'
    this._onTabChange = (event) => this._activateTab(event.detail?.tab)
    this._onActorSelect = (event) => this._actorDetail?.show(event.detail.actor)
    this._onMemoryRefresh = () => this._fetchKgraph()
    this._onClearLogs = () => this._clearLogs()
    this._onClearTraces = () => this._clearTraces()
  }

  connectedCallback() {
    this._render()
    this._bindEvents()
  }

  disconnectedCallback() {
    this._tabs?.removeEventListener('tab-change', this._onTabChange)
    this._actorTree?.removeEventListener('actor-select', this._onActorSelect)
    this._memoryRefresh?.removeEventListener('click', this._onMemoryRefresh)
    this._clearLogsBtn?.removeEventListener('click', this._onClearLogs)
    this._clearTracesBtn?.removeEventListener('click', this._onClearTraces)
  }

  handleMetrics(msg) {
    const event = msg
    this.$('#metrics-empty')?.remove()

    const actors = event.actors || []
    let totRecv = 0
    let totDone = 0
    let totFail = 0
    actors.forEach(a => {
      totRecv += a.messagesReceived  || 0
      totDone += a.messagesProcessed || 0
      totFail += a.messagesFailed    || 0
    })

    if (actors.length > 0) {
      this._sumActors.textContent = actors.length
      this._sumRecv.textContent   = totRecv
      this._sumDone.textContent   = totDone
      this._sumFail.textContent   = totFail
    }

    const selectedActor = this._actorTree?.update(actors)
    if (selectedActor) this._actorDetail?.show(selectedActor)
    if (event.topics) this._topicList?.update(event.topics)
    this._syncToolbar()
  }

  handleLog(msg) {
    const count = this._logStream?.append(msg) ?? 0
    this._logCount.textContent = `${count} event${count !== 1 ? 's' : ''}`
  }

  handleTrace(msg) {
    this._tracesList?.addSpan(msg)
    if (this._activeTab === 'traces') this._tracesList?.render()
    const size = this._tracesList?.size ?? 0
    this._tracesCount.textContent = `${size} trace${size !== 1 ? 's' : ''}`
  }

  handleUsage(msg) {
    this._costsTable?.addUsage(msg)
    if (this._activeTab === 'costs') this._costsTable?.render()
  }

  handleToolRegistered(msg) {
    this._toolsList?.register(msg.name, msg.schema)
  }

  handleToolUnregistered(msg) {
    this._toolsList?.unregister(msg.name)
  }

  _render() {
    this.innerHTML = `
      <div class="obs-bar">
        <r-tabs class="obs-subtabs">
          <button class="obs-subtab active" data-subtab="metrics">metrics</button>
          <button class="obs-subtab" data-subtab="topics">topics</button>
          <button class="obs-subtab" data-subtab="logs">logs</button>
          <button class="obs-subtab" data-subtab="traces">traces</button>
          <button class="obs-subtab" data-subtab="tools">tools</button>
          <button class="obs-subtab" data-subtab="memory">memory</button>
          <button class="obs-subtab" data-subtab="costs">costs</button>
        </r-tabs>
        <div class="obs-bar-end">
          <div class="metrics-summary" data-control="metrics-summary" hidden>
            <div class="summary-stat">
              <span class="summary-val" data-summary="actors">0</span>
              <span class="summary-key">actors</span>
            </div>
            <div class="summary-stat">
              <span class="summary-val" data-summary="recv">0</span>
              <span class="summary-key">recv</span>
            </div>
            <div class="summary-stat">
              <span class="summary-val" data-summary="done">0</span>
              <span class="summary-key">done</span>
            </div>
            <div class="summary-stat">
              <span class="summary-val" data-summary="fail">0</span>
              <span class="summary-key">fail</span>
            </div>
          </div>
          <div class="obs-log-controls" data-control="obs-log-controls" hidden>
            <span class="log-count" data-log-count>0 events</span>
            <button class="btn-clear" data-clear-logs>clear</button>
          </div>
          <div class="obs-traces-controls" data-control="obs-traces-controls" hidden>
            <span class="log-count" data-traces-count>0 traces</span>
            <button class="btn-clear" data-clear-traces>clear</button>
          </div>
          <div class="obs-memory-controls" data-control="obs-memory-controls" hidden>
            <span class="log-count" data-memory-stats></span>
            <button class="btn-clear" data-memory-refresh>refresh</button>
          </div>
        </div>
      </div>

      <div data-observe-tab="metrics" class="obs-subpanel active">
        <div class="metrics-layout">
          <div class="tree-col">
            <r-actor-tree>
              <r-empty-state id="metrics-empty" variant="panel" name="monitor" text="awaiting metrics snapshot"></r-empty-state>
            </r-actor-tree>
          </div>
          <div class="detail-col">
            <r-actor-detail>
              <r-empty-state variant="panel" name="eye" text="select an actor to inspect"></r-empty-state>
            </r-actor-detail>
          </div>
        </div>
      </div>

      <div data-observe-tab="topics" class="obs-subpanel">
        <r-topic-list>
          <r-empty-state variant="panel" name="activity" text="awaiting metrics snapshot"></r-empty-state>
        </r-topic-list>
      </div>

      <div data-observe-tab="traces" class="obs-subpanel">
        <r-trace-waterfall>
          <r-empty-state variant="panel" name="waterfall" text="awaiting traces"></r-empty-state>
        </r-trace-waterfall>
      </div>

      <div data-observe-tab="logs" class="obs-subpanel">
        <r-log-stream>
          <r-empty-state variant="panel" name="terminal" text="awaiting log events"></r-empty-state>
        </r-log-stream>
      </div>

      <div data-observe-tab="tools" class="obs-subpanel">
        <r-tools-list>
          <r-empty-state variant="panel" name="wrench" text="no tools registered"></r-empty-state>
        </r-tools-list>
      </div>

      <r-costs-table data-observe-tab="costs" class="obs-subpanel">
        <r-empty-state variant="panel" text="no usage data yet"></r-empty-state>
        <table class="costs-table" style="display:none">
          <thead>
            <tr>
              <th>role</th>
              <th>model</th>
              <th>in</th>
              <th>out</th>
              <th>ctx</th>
              <th>cost</th>
            </tr>
          </thead>
          <tbody></tbody>
          <tfoot></tfoot>
        </table>
      </r-costs-table>

      <div data-observe-tab="memory" class="obs-subpanel">
        <r-force-graph>
          <r-empty-state variant="panel" name="network" text="no graph data"></r-empty-state>
        </r-force-graph>
      </div>
    `
  }

  _bindEvents() {
    this._tabs = this.$('r-tabs.obs-subtabs')
    this._actorTree = this.$('r-actor-tree')
    this._actorDetail = this.$('r-actor-detail')
    this._topicList = this.$('r-topic-list')
    this._logStream = this.$('r-log-stream')
    this._tracesList = this.$('r-trace-waterfall')
    this._toolsList = this.$('r-tools-list')
    this._costsTable = this.$('r-costs-table')
    this._memoryGraph = this.$('r-force-graph')
    this._metricsSummary = this.$('[data-control="metrics-summary"]')
    this._logControls = this.$('[data-control="obs-log-controls"]')
    this._tracesControls = this.$('[data-control="obs-traces-controls"]')
    this._memoryControls = this.$('[data-control="obs-memory-controls"]')
    this._sumActors = this.$('[data-summary="actors"]')
    this._sumRecv = this.$('[data-summary="recv"]')
    this._sumDone = this.$('[data-summary="done"]')
    this._sumFail = this.$('[data-summary="fail"]')
    this._logCount = this.$('[data-log-count]')
    this._tracesCount = this.$('[data-traces-count]')
    this._memoryStats = this.$('[data-memory-stats]')
    this._memoryRefresh = this.$('[data-memory-refresh]')
    this._clearLogsBtn = this.$('[data-clear-logs]')
    this._clearTracesBtn = this.$('[data-clear-traces]')

    this._tabs?.addEventListener('tab-change', this._onTabChange)
    this._actorTree?.addEventListener('actor-select', this._onActorSelect)
    this._memoryRefresh?.addEventListener('click', this._onMemoryRefresh)
    this._clearLogsBtn?.addEventListener('click', this._onClearLogs)
    this._clearTracesBtn?.addEventListener('click', this._onClearTraces)
    this._syncToolbar()
  }

  _activateTab(tab) {
    if (!tab) return
    this._activeTab = tab
    this.$$('[data-observe-tab]').forEach(panel => {
      panel.classList.toggle('active', panel.dataset.observeTab === tab)
    })
    this._syncToolbar()
    if (tab === 'traces') this._tracesList?.render()
    if (tab === 'memory') this._fetchKgraph()
    if (tab === 'costs') this._costsTable?.render()
  }

  _syncToolbar() {
    const controls = {
      'metrics-summary':     this._metricsSummary,
      'obs-log-controls':    this._logControls,
      'obs-traces-controls': this._tracesControls,
      'obs-memory-controls': this._memoryControls,
    }

    for (const [name, el] of Object.entries(controls)) {
      if (!el) continue
      const isMetrics = name === 'metrics-summary'
      const visible = CONTROL_BY_TAB[this._activeTab] === name &&
        (!isMetrics || Object.keys(this._actorTree?.actorsMap ?? {}).length > 0)
      el.hidden = !visible
    }
  }

  async _fetchKgraph() {
    this._memoryStats.textContent = 'loading...'
    try {
      const res = await fetch(new URL('kgraph', location.href))
      const graph = await res.json()
      this._memoryGraph?.renderKnowledgeGraph(graph)
      this._memoryStats.textContent = `${graph.nodes.length} nodes · ${graph.edges.length} edges`
    } catch {
      this._memoryStats.textContent = 'error'
    }
  }

  _clearLogs() {
    const count = this._logStream?.clear() ?? 0
    this._logCount.textContent = `${count} events`
  }

  _clearTraces() {
    this._tracesList?.clear()
    this._tracesCount.textContent = '0 traces'
  }
}

defineElement('r-observe-panel', RObservePanel)
