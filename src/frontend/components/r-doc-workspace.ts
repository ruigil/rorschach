import { html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { store, StoreController } from '../store.js';

const LS_OPEN     = 'rorschach.docWorkspaceOpen';
const LS_ARTIFACT = 'rorschach.docWorkspaceArtifact';

@customElement('r-doc-workspace')
export class RDocWorkspace extends RorschachBase {
  private _isResizing = false;
  private _initialized = false;
  private _WIDTH_KEY = 'rorschach.docWorkspaceWidth';
  private _MIN_WIDTH = 350;

  // Track previous store values to detect changes in updated()
  private _lastArtifact: string | null = null;

  private _currentDocArtifact = new StoreController(this, 'currentDocArtifact');
  private _docWorkspaceOpen = new StoreController(this, 'docWorkspaceOpen');

  // Use light DOM so workspace.css rules apply directly (same as r-plan-workspace)
  override createRenderRoot() {
    return this;
  }

  get _panel() {
    return this.closest('#panel-chat') as HTMLElement;
  }

  _maxWorkspaceWidth() {
    const panelWidth = this._panel?.getBoundingClientRect().width ?? window.innerWidth;
    return Math.max(this._MIN_WIDTH, Math.round(panelWidth * 0.7));
  }

  _clampWidth(width: number) {
    return Math.max(this._MIN_WIDTH, Math.min(this._maxWorkspaceWidth(), width));
  }

  _savedWidth() {
    const panelWidth = this._panel?.getBoundingClientRect().width ?? window.innerWidth;
    const defaultWidth = Math.round(panelWidth / 2);
    const raw = localStorage.getItem(this._WIDTH_KEY);
    const parsed = raw ? Number(raw) : defaultWidth;
    return Number.isFinite(parsed) ? this._clampWidth(parsed) : defaultWidth;
  }

  _applyWidth(width: number) {
    const next = this._clampWidth(width);
    this._panel?.style.setProperty('--doc-workspace-width', `${next}px`);
    return next;
  }

  _setOpen(open: boolean, artifact: string | null = null) {
    const resolvedArtifact = open ? (artifact ?? (this._currentDocArtifact.value as string | null) ?? 'index.html') : null;
    store.set('docWorkspaceOpen', open);
    store.set('currentDocArtifact', resolvedArtifact);
    // Persist to localStorage so state survives refresh
    localStorage.setItem(LS_OPEN, String(open));
    if (resolvedArtifact) {
      localStorage.setItem(LS_ARTIFACT, resolvedArtifact);
    } else {
      localStorage.removeItem(LS_ARTIFACT);
    }
    this._panel?.classList.toggle('doc-workspace-open', open);
    if (open) this._applyWidth(this._savedWidth());
  }

  close() {
    this._setOpen(false);
  }

  goHome() {
    // Navigate to index.html and persist
    store.set('currentDocArtifact', 'index.html');
    localStorage.setItem(LS_ARTIFACT, 'index.html');
  }

  override updated() {
    const isOpen = !!this._docWorkspaceOpen.value;
    const artifact = this._currentDocArtifact.value as string | null;

    if (!this._initialized) {
      this._initialized = true;
      // ── Restore from localStorage on first render ──
      const savedOpen     = localStorage.getItem(LS_OPEN) === 'true';
      const savedArtifact = localStorage.getItem(LS_ARTIFACT) ?? 'index.html';
      if (savedOpen) {
        this._setOpen(true, savedArtifact);
      } else {
        // Ensure panel class is clean
        this._panel?.classList.remove('doc-workspace-open');
      }
      this._lastArtifact = artifact;
      return;
    }

    // ── Keep panel class in sync with store (e.g. when WS frame opens workspace) ──
    this._panel?.classList.toggle('doc-workspace-open', isOpen);
    if (isOpen) this._applyWidth(this._savedWidth());

    // ── Persist artifact changes from WS frames or goHome() ──
    if (artifact !== this._lastArtifact) {
      this._lastArtifact = artifact;
      if (artifact) {
        localStorage.setItem(LS_ARTIFACT, artifact);
        localStorage.setItem(LS_OPEN, 'true');
      } else {
        localStorage.setItem(LS_OPEN, 'false');
        localStorage.removeItem(LS_ARTIFACT);
      }
    }
  }

  // Always render the shell — CSS hides it when not open, same as plan-workspace
  override render() {
    const artifact = this._currentDocArtifact.value as string | null;
    const frameUrl = artifact ? `/artifacts/${artifact}` : '';

    return html`
      <div class="doc-workspace-resizer" role="separator" aria-orientation="vertical" aria-label="Resize documentation workspace"></div>
      <aside class="doc-workspace" aria-label="Documentation workspace">
        <div class="doc-workspace-header">
          <div class="doc-workspace-title-area">
            ${this.renderIcon('file')}
            <h2 class="doc-workspace-title">Documentation</h2>
          </div>
          <div class="doc-workspace-actions">
            <button class="doc-workspace-home" aria-label="Go to home page" @click=${this.goHome}>
              Home
            </button>
            <button class="doc-workspace-close" aria-label="Close documentation panel" @click=${this.close}>
              ×
            </button>
          </div>
        </div>
        <div class="doc-workspace-body">
          ${frameUrl ? html`
            <iframe
              src="${frameUrl}"
              class="doc-workspace-iframe"
              title="System Documentation"
              sandbox="allow-same-origin allow-scripts allow-popups"
            ></iframe>
          ` : html`<div class="doc-workspace-empty"><span>no document loaded</span></div>`}
        </div>
      </aside>
    `;
  }

  protected override firstUpdated() {
    const resizer = this.querySelector('.doc-workspace-resizer') as HTMLElement;
    if (!resizer) return;

    resizer.addEventListener('pointerdown', (event) => {
      if (!this._panel?.classList.contains('doc-workspace-open')) return;
      this._isResizing = true;
      resizer.setPointerCapture(event.pointerId);
      document.body.classList.add('doc-workspace-resizing');
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
      document.body.classList.remove('doc-workspace-resizing');
      if (event.pointerId !== undefined && resizer?.hasPointerCapture(event.pointerId)) {
        resizer.releasePointerCapture(event.pointerId);
      }
    };

    resizer.addEventListener('pointerup', finishResize);
    resizer.addEventListener('pointercancel', finishResize);

    window.addEventListener('resize', () => {
      if (!this._panel?.classList.contains('doc-workspace-open')) return;
      const width = this._applyWidth(this._savedWidth());
      localStorage.setItem(this._WIDTH_KEY, String(width));
    });
  }
}
