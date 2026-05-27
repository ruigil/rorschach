import { html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { store, StoreController } from '../store.js';
import { WINDOW_REGISTRY } from '../core/window-registry.js';
import { closeWindow, focusWindow, setActiveWorkspaceTab, updateWindowState } from '../actions.js';

@customElement('r-window')
export class RWindow extends RorschachBase {
  @property({ type: String }) windowId!: string;

  @state() private _isDragging = false;

  private _windows = new StoreController(this, 'windows');
  private _activeWindowIds = new StoreController(this, 'activeWindowIds');
  private _resizeObserver?: ResizeObserver;
  private _cachedContentElements = new Map<string, HTMLElement>();

  override createRenderRoot() {
    return this; // Light DOM for direct style.css/workspace.css inclusion
  }

  get config() {
    return (this._windows.value as any)[this.windowId];
  }

  get isFocused() {
    const list = this._activeWindowIds.value as string[];
    return list[list.length - 1] === this.windowId;
  }

  override connectedCallback() {
    super.connectedCallback();

    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver((entries) => {
        const win = this.config;
        if (!win || win.isDocked || win.isMinimized) return;
        for (const entry of entries) {
          const width = this.offsetWidth;
          const height = this.offsetHeight;
          if (width === 0 || height === 0) continue;
          if (Math.abs(win.w - width) > 2 || Math.abs(win.h - height) > 2) {
            this._updateState({ w: width, h: height });
          }
        }
      });
      this._resizeObserver.observe(this);
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._resizeObserver?.disconnect();
  }

  private _getContentElement() {
    const config = WINDOW_REGISTRY[this.windowId];
    if (!config) return null;

    let el = this._cachedContentElements.get(this.windowId);
    if (!el) {
      el = document.createElement(config.contentTag);
      (el as any).windowId = this.windowId;
      this._cachedContentElements.set(this.windowId, el);
    }
    return el;
  }

  private _handleDragStart(e: PointerEvent) {
    const win = this.config;
    if (!win || win.isDocked) return;
    if (e.button !== 0) return; // Left click only

    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('input') || target.closest('textarea')) return;

    e.preventDefault();
    this._isDragging = true;
    focusWindow(this.windowId);

    const startX = e.clientX;
    const startY = e.clientY;
    const initialX = win.x;
    const initialY = win.y;

    const onPointerMove = (moveEv: PointerEvent) => {
      const dx = moveEv.clientX - startX;
      const dy = moveEv.clientY - startY;

      const nextX = Math.max(0, Math.min(window.innerWidth - 150, initialX + dx));
      const nextY = Math.max(0, Math.min(window.innerHeight - 50, initialY + dy));

      this._updateState({ x: nextX, y: nextY });
    };

    const onPointerUp = () => {
      this._isDragging = false;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  private _handleDockResize(e: PointerEvent) {
    const win = this.config;
    if (!win || !win.isDocked) return;
    e.preventDefault();
    const resizer = e.target as HTMLElement;
    resizer.setPointerCapture(e.pointerId);

    const initialWidth = win.w;
    const startX = e.clientX;

    const onPointerMove = (moveEv: PointerEvent) => {
      const dx = moveEv.clientX - startX;
      let nextWidth = initialWidth;

      if (this.windowId === 'chat') {
        nextWidth = Math.max(300, initialWidth + dx);
      } else {
        nextWidth = Math.max(320, initialWidth - dx);
      }

      this._updateState({ w: nextWidth });
    };

    const onPointerUp = () => {
      if (resizer.hasPointerCapture(e.pointerId)) {
        resizer.releasePointerCapture(e.pointerId);
      }
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  private _toggleDock() {
    const win = this.config;
    if (!win) return;
    const nextDocked = !win.isDocked;
    this._updateState({ isDocked: nextDocked });

    // When docking back workspace tabs, ensure the tab selection matches
    if (nextDocked && this.windowId !== 'chat') {
      setActiveWorkspaceTab(this.windowId);
    }
  }

  private _close() {
    closeWindow(this.windowId);
  }

  private _updateState(updates: Partial<any>) {
    updateWindowState(this.windowId, updates);
  }

  override updated() {
    const win = this.config;
    if (!win || !win.isOpen) {
      this.style.display = 'none';
      return;
    }

    this.style.display = 'flex';

    if (!win.isDocked) {
      this.classList.add('floating');
      this.classList.toggle('dragging', this._isDragging);
      this.style.position = 'fixed';
      this.style.left = `${win.x}px`;
      this.style.top = `${win.y}px`;
      this.style.width = `${win.w}px`;
      this.style.height = `${win.h}px`;
      this.style.zIndex = `${win.zIndex}`;
    } else {
      this.classList.remove('floating', 'dragging');
      this.style.position = '';
      this.style.left = '';
      this.style.top = '';
      this.style.width = `${win.w}px`;
      this.style.height = '';
      this.style.zIndex = '';
    }
  }

  override render() {
    const win = this.config;
    if (!win || !win.isOpen) return html``;

    const contentEl = this._getContentElement();

    return html`
      ${win.isDocked && this.windowId !== 'chat' ? html`
        <div class="r-window-resizer resizer-left" @pointerdown=${this._handleDockResize}></div>
      ` : ''}

      <div class="r-window-chrome ${this.isFocused ? 'active-focus' : ''}" @pointerdown=${() => focusWindow(this.windowId)}>
        <div class="r-window-header" @pointerdown=${this._handleDragStart}>
          <div class="r-window-title">
            ${this.renderIcon((WINDOW_REGISTRY[this.windowId]?.icon ?? 'file') as any)}
            <span>${WINDOW_REGISTRY[this.windowId]?.title ?? this.windowId}</span>
          </div>
          <div class="r-window-controls">
            <button class="win-btn dock-btn" @click=${this._toggleDock} title="${win.isDocked ? 'Undock floating window' : 'Dock to main panel'}">
              ${this.renderIcon((win.isDocked ? 'popup' : 'dock') as any)}
            </button>
            <button class="win-btn close-btn" @click=${this._close} title="Close">
              ×
            </button>
          </div>
        </div>

        <div class="r-window-body">
          ${contentEl}
        </div>
      </div>

      ${win.isDocked && this.windowId === 'chat' ? html`
        <div class="r-window-resizer resizer-right" @pointerdown=${this._handleDockResize}></div>
      ` : ''}
    `;
  }
}
