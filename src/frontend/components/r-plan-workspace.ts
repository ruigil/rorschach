import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { RorschachBase, escHtml } from './base.js';
import { store } from '../store.js';

@customElement('r-plan-workspace')
export class RPlanWorkspace extends RorschachBase {
  private _currentGraph: any = null;
  private _selectedTaskId: string | null = null;
  private _isResizing = false;
  private _WIDTH_KEY = 'rorschach.planWorkspaceWidth';
  private _DEFAULT_WIDTH = 460;
  private _MIN_WIDTH = 320;
  private _MIN_CHAT_WIDTH = 360;
  private _unsubMode: (() => void) | null = null;

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this._bindEvents();
    this._unsubMode = store.subscribe('currentMode', (mode) => {
      if (mode === 'executor') this.openList();
      else this.close();
    });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubMode?.();
    this._unsubMode = null;
  }

  async openList() {
    this._setOpen(true);
    this._setTitle('Plans');
    const bodyEl = this.querySelector('.plan-workspace-body');
    if (bodyEl) bodyEl.innerHTML = this._emptyPanel('loading plans');
    try {
      this._renderPlanList(await this._fetchJson('plans'));
    } catch {
      if (bodyEl) bodyEl.innerHTML = this._emptyPanel('could not load plans');
    }
  }

  async openGraph(planId: string) {
    this._setOpen(true);
    this._setTitle('Plan');
    const bodyEl = this.querySelector('.plan-workspace-body');
    if (bodyEl) bodyEl.innerHTML = this._emptyPanel('loading graph');
    try {
      this._renderGraph(await this._fetchJson(`plans/${encodeURIComponent(planId)}/graph`));
    } catch {
      if (bodyEl) bodyEl.innerHTML = this._emptyPanel('could not load graph');
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

  _setTitle(text: string) {
    const titleEl = this.querySelector('.plan-workspace-title');
    if (titleEl) titleEl.textContent = text;
  }

  _emptyPanel(text: string) {
    return `<div class="plan-empty"><span>${escHtml(text)}</span></div>`;
  }

  override render() {
    return html`
      <div class="plan-workspace-resizer" role="separator" aria-orientation="vertical" aria-label="Resize plan workspace"></div>
      <aside class="plan-workspace" aria-label="Plan workspace">
        <div class="plan-workspace-header">
          <div>
            <div class="plan-workspace-kicker">Executor</div>
            <h2 class="plan-workspace-title">Plans</h2>
          </div>
          <button class="plan-workspace-close" aria-label="Close plan workspace" @click=${this.close}>×</button>
        </div>
        <div class="plan-workspace-body"></div>
      </aside>
    `;
  }

  private _bindEvents() {
    // Note: Event binding for resizer needs to happen after render or via delegated events
    // Since we use Light DOM and standard Lit render, it's easier to use @click etc in render()
    // but for resizer we need pointer events.
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
      if (this._currentGraph) this._renderGraph(this._currentGraph);
    };

    resizer.addEventListener('pointerup', finishResize);
    resizer.addEventListener('pointercancel', finishResize);

    window.addEventListener('resize', () => {
      if (!this._panel?.classList.contains('plan-workspace-open')) return;
      const width = this._applyWidth(this._savedWidth());
      localStorage.setItem(this._WIDTH_KEY, String(width));
      if (this._currentGraph) this._renderGraph(this._currentGraph);
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

  private _renderPlanList(plans: any[]) {
    this._currentGraph = null;
    this._selectedTaskId = null;
    this._setTitle('Plans');
    const bodyEl = this.querySelector('.plan-workspace-body');
    if (!bodyEl) return;
    if (!plans.length) {
      bodyEl.innerHTML = this._emptyPanel('no saved plans');
      return;
    }

    const list = document.createElement('div');
    list.className = 'plan-list';
    for (const plan of plans) {
      const btn = document.createElement('button');
      btn.className = 'plan-list-item';
      btn.type = 'button';
      btn.dataset.planId = plan.id;
      btn.innerHTML = `
        <span class="plan-list-goal">${escHtml(plan.goal)}</span>
        <span class="plan-list-meta">${escHtml(this._formatDate(plan.createdAt))} · ${plan.taskCount} task${plan.taskCount === 1 ? '' : 's'}</span>
      `;
      btn.addEventListener('click', () => this.openGraph(plan.id));
      list.appendChild(btn);
    }
    bodyEl.replaceChildren(list);
  }

  private _taskById(id: string) {
    return this._currentGraph?.nodes.find((node: any) => node.id === id) ?? null;
  }

  private _renderTaskDetail(task: any) {
    const detail = document.createElement('div');
    detail.className = 'plan-task-detail';
    if (!task) {
      detail.innerHTML = '<div class="plan-task-placeholder">Select a task to inspect details.</div>';
      return detail;
    }

    const deps = task.dependencies.length
      ? task.dependencies.map((id: string) => this._taskById(id)?.label || id).join(', ')
      : 'none';
    const dependents = task.dependents.length
      ? task.dependents.map((id: string) => this._taskById(id)?.label || id).join(', ')
      : 'none';

    detail.innerHTML = `
      <div class="plan-task-status">status · not tracked</div>
      <h3>${escHtml(task.label)}</h3>
      <dl>
        <dt>Description</dt>
        <dd>${escHtml(task.description || 'No description')}</dd>
        <dt>Validation</dt>
        <dd>${escHtml(task.validationCriteria || 'No validation criteria')}</dd>
        <dt>Depends on</dt>
        <dd>${escHtml(deps)}</dd>
        <dt>Unlocks</dt>
        <dd>${escHtml(dependents)}</dd>
      </dl>
    `;
    return detail;
  }

  private _renderGraph(graph: any) {
    const nextSelectedTaskId = this._selectedTaskId;
    this._currentGraph = graph;
    this._selectedTaskId = graph.nodes.some((node: any) => node.id === nextSelectedTaskId)
      ? nextSelectedTaskId
      : graph.nodes[0]?.id ?? null;
    this._setTitle(graph.plan.goal);
    const bodyEl = this.querySelector('.plan-workspace-body');
    if (!bodyEl) return;

    const shell = document.createElement('div');
    shell.className = 'plan-graph-shell';
    const meta = document.createElement('div');
    meta.className = 'plan-graph-meta';
    meta.textContent = `${this._formatDate(graph.plan.createdAt)} · ${graph.plan.taskCount} task${graph.plan.taskCount === 1 ? '' : 's'}`;
    const graphEl = document.createElement('r-force-graph') as any;
    graphEl.className = 'plan-graph';
    const detailWrap = document.createElement('div');
    detailWrap.className = 'plan-task-detail-wrap';
    shell.append(meta, graphEl, detailWrap);
    bodyEl.replaceChildren(shell);

    const updateDetail = () => {
      detailWrap.replaceChildren(this._renderTaskDetail(this._taskById(this._selectedTaskId!)));
    };
    updateDetail();

    if (!graph.nodes.length) {
      graphEl.innerHTML = this._emptyPanel('plan has no tasks');
      return;
    }

    graphEl.renderPlanGraph(graph, this._selectedTaskId, (id: string) => {
      this._selectedTaskId = id;
      updateDetail();
    });
  }
}
