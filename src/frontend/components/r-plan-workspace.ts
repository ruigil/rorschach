import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { store, StoreController } from '../store.js';

@customElement('r-plan-workspace')
export class RPlanWorkspace extends RorschachBase {
  @state() private _view: 'list' | 'graph' | 'loading' | 'error' = 'list';
  @state() private _errorMsg = '';
  @state() private _plans: any[] = [];
  @state() private _currentGraph: any = null;
  @state() private _selectedTaskId: string | null = null;
  @state() private _title = 'Plans';

  private _isResizing = false;
  private _WIDTH_KEY = 'rorschach.planWorkspaceWidth';
  private _DEFAULT_WIDTH = 460;
  private _MIN_WIDTH = 320;
  private _MIN_CHAT_WIDTH = 360;

  private _currentMode = new StoreController(this, 'currentMode');
  private _currentPlanGraph = new StoreController(this, 'currentPlanGraph');

  override createRenderRoot() {
    return this;
  }

  override updated(changedProperties: Map<string, any>) {
    const mode = this._currentMode.value;
    if (mode === 'executor') this.openList();
    else if (mode !== 'planner') this.close();

    if (changedProperties.has('_currentPlanGraph') && this._currentPlanGraph.value) {
      this._view = 'graph';
      this._currentGraph = this._currentPlanGraph.value;
      this._selectedTaskId = this._currentGraph.nodes[0]?.id ?? null;
      this._title = this._currentGraph.plan.goal;
    }
  }

  async openList() {
    this._setOpen(true);
    this._title = 'Plans';
    this._view = 'loading';
    try {
      this._plans = await this._fetchJson('plans');
      this._view = 'list';
    } catch {
      this._errorMsg = 'could not load plans';
      this._view = 'error';
    }
  }

  async openGraph(planId: string) {
    this._setOpen(true);
    this._title = 'Plan';
    this._view = 'loading';
    try {
      this._currentGraph = await this._fetchJson(`plans/${encodeURIComponent(planId)}/graph`);
      this._selectedTaskId = this._currentGraph.nodes[0]?.id ?? null;
      this._title = this._currentGraph.plan.goal;
      this._view = 'graph';
    } catch {
      this._errorMsg = 'could not load graph';
      this._view = 'error';
    }
  }

  close() {
    this._setOpen(false);
  }

  get _panel() {
    return this.closest('#panel-chat') as HTMLElement;
  }

  _maxWorkspaceWidth() {
    const panelWidth = this._panel?.getBoundingClientRect().width ?? window.innerWidth;
    return Math.max(this._MIN_WIDTH, Math.min(760, panelWidth - this._MIN_CHAT_WIDTH));
  }

  _clampWidth(width: number) {
    return Math.max(this._MIN_WIDTH, Math.min(this._maxWorkspaceWidth(), width));
  }

  _savedWidth() {
    const raw = localStorage.getItem(this._WIDTH_KEY);
    const parsed = raw ? Number(raw) : this._DEFAULT_WIDTH;
    return Number.isFinite(parsed) ? this._clampWidth(parsed) : this._DEFAULT_WIDTH;
  }

  _applyWidth(width: number) {
    const next = this._clampWidth(width);
    this._panel?.style.setProperty('--plan-workspace-width', `${next}px`);
    return next;
  }

  _setOpen(open: boolean) {
    this._panel?.classList.toggle('plan-workspace-open', open);
    if (open) this._applyWidth(this._savedWidth());
  }

  override render() {
    return html`
      <div class="plan-workspace-resizer" role="separator" aria-orientation="vertical" aria-label="Resize plan workspace"></div>
      <aside class="plan-workspace" aria-label="Plan workspace">
        <div class="plan-workspace-header">
          <div>
            <div class="plan-workspace-kicker">Executor</div>
            <h2 class="plan-workspace-title">${this._title}</h2>
          </div>
          <button class="plan-workspace-close" aria-label="Close plan workspace" @click=${this.close}>×</button>
        </div>
        <div class="plan-workspace-body">
          ${this._renderContent()}
        </div>
      </aside>
    `;
  }

  private _renderContent() {
    switch (this._view) {
      case 'loading':
        return html`<div class="plan-empty"><span>loading...</span></div>`;
      case 'error':
        return html`<div class="plan-empty"><span>${this._errorMsg}</span></div>`;
      case 'list':
        return this._renderPlanList();
      case 'graph':
        return this._renderGraphView();
      default:
        return nothing;
    }
  }

  private _renderPlanList() {
    if (!this._plans.length) {
      return html`<div class="plan-empty"><span>no saved plans</span></div>`;
    }

    return html`
      <div class="plan-list">
        ${this._plans.map(plan => html`
          <button class="plan-list-item" type="button" @click=${() => this.openGraph(plan.id)}>
            <span class="plan-list-goal">${plan.goal}</span>
            <span class="plan-list-meta">${this._formatDate(plan.createdAt)} · ${plan.taskCount} task${plan.taskCount === 1 ? '' : 's'}</span>
          </button>
        `)}
      </div>
    `;
  }

  private _renderGraphView() {
    if (!this._currentGraph || !this._currentGraph.nodes.length) {
      return html`<div class="plan-empty"><span>plan has no tasks</span></div>`;
    }

    return html`
      <div class="plan-graph-shell">
        <div class="plan-graph-meta">
          ${this._formatDate(this._currentGraph.plan.createdAt)} · ${this._currentGraph.plan.taskCount} task${this._currentGraph.plan.taskCount === 1 ? '' : 's'}
        </div>
        <r-force-graph 
          class="plan-graph" 
          .planData=${this._currentGraph}
          .selectedTaskId=${this._selectedTaskId}
          @node-select=${(e: CustomEvent) => this._selectedTaskId = e.detail.id}
        ></r-force-graph>
        <div class="plan-task-detail-wrap">
          ${this._renderTaskDetail(this._taskById(this._selectedTaskId!))}
        </div>
      </div>
    `;
  }

  private _taskById(id: string) {
    return this._currentGraph?.nodes.find((node: any) => node.id === id) ?? null;
  }

  private _renderTaskDetail(task: any) {
    if (!task) {
      return html`<div class="plan-task-placeholder">Select a task to inspect details.</div>`;
    }

    const deps = task.dependencies.length
      ? task.dependencies.map((id: string) => this._taskById(id)?.label || id).join(', ')
      : 'none';
    const dependents = task.dependents.length
      ? task.dependents.map((id: string) => this._taskById(id)?.label || id).join(', ')
      : 'none';

    return html`
      <div class="plan-task-detail">
        <div class="plan-task-status">status · not tracked</div>
        <h3>${task.label}</h3>
        <dl>
          <dt>Description</dt>
          <dd>${task.description || 'No description'}</dd>
          <dt>Validation</dt>
          <dd>${task.validationCriteria || 'No validation criteria'}</dd>
          <dt>Depends on</dt>
          <dd>${deps}</dd>
          <dt>Unlocks</dt>
          <dd>${dependents}</dd>
        </dl>
      </div>
    `;
  }

  protected override firstUpdated() {
    const resizer = this.querySelector('.plan-workspace-resizer') as HTMLElement;
    if (!resizer) return;

    resizer.addEventListener('pointerdown', (event) => {
      if (!this._panel?.classList.contains('plan-workspace-open')) return;
      this._isResizing = true;
      resizer.setPointerCapture(event.pointerId);
      document.body.classList.add('plan-workspace-resizing');
      event.preventDefault();
    });

    resizer.addEventListener('pointermove', (event) => {
      if (!this._isResizing || !this._panel) return;
      const rect = this._panel.getBoundingClientRect();
      const width = this._applyWidth(rect.right - event.clientX);
      localStorage.setItem(this._WIDTH_KEY, String(width));
    });

    const finishResize = (event: PointerEvent) => {
      if (!this._isResizing) return;
      this._isResizing = false;
      document.body.classList.remove('plan-workspace-resizing');
      if (event.pointerId !== undefined && resizer?.hasPointerCapture(event.pointerId)) {
        resizer.releasePointerCapture(event.pointerId);
      }
    };

    resizer.addEventListener('pointerup', finishResize);
    resizer.addEventListener('pointercancel', finishResize);

    window.addEventListener('resize', () => {
      if (!this._panel?.classList.contains('plan-workspace-open')) return;
      const width = this._applyWidth(this._savedWidth());
      localStorage.setItem(this._WIDTH_KEY, String(width));
    });
  }

  private async _fetchJson(path: string) {
    const res = await fetch(new URL(path, location.href));
    if (!res.ok) throw new Error(await res.text());
    return await res.json();
  }

  private _formatDate(value: any) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
  }
}
