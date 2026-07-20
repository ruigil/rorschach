import {
  customElement,
  html,
  RorschachBase,
  state,
  store,
  StoreController,
  connect,
  onMessage
} from '@rorschach/webkit';

import { dispatchFrame } from './dispatcher.js';
import { logout, switchMode } from './actions.js';
import {
  openView,
  closeView,
  setActiveWorkspaceTab,
  reorderWorkspaceTabs,
  reconcileWorkspaceTabOrder,
} from './view-actions.js';
import type { ShellState } from './types.js';
import { pluginHost } from './plugin-host.js';

const TAB_DND_MIME = 'application/x-rorschach-tab';

@customElement('r-shell')
export class RShell extends RorschachBase {
  private _currentUserId = new StoreController(this, ['shell', 'currentUserId']);
  private _currentUserRoles = new StoreController(this, ['shell', 'currentUserRoles']);
  private _isWaiting = new StoreController(this, ['shell', 'isWaiting']);

  private _views = new StoreController(this, ['shell', 'views']);
  private _activeWorkspaceTab = new StoreController(this, ['shell', 'activeWorkspaceTab']);
  private _workspaceTabOrder = new StoreController(this, ['shell', 'workspaceTabOrder']);
  private _currentMode = new StoreController(this, ['shell', 'currentMode']);
  private _currentModeDisplayName = new StoreController(this, ['shell', 'currentModeDisplayName']);

  @state() private _noticing = false;
  private _prevWaiting = false;

  private _sidebarWidth = new StoreController(this, ['shell', 'sidebarWidth']);
  @state() private _isSidebarCollapsed = false;

  @state() private _draggingTabId: string | null = null;
  @state() private _dropTargetId: string | null = null;
  @state() private _dropPlace: 'before' | 'after' = 'before';
  private _didDrag = false;

  override createRenderRoot() {
    return this; // Light DOM to integrate globally
  }

  override connectedCallback() {
    super.connectedCallback();
    this._bootstrap();

    // 1. Initial hydration: Sync URL hash to store state on load
    const initialHash = window.location.hash.replace(/^#\/?/, '');
    if (initialHash) {
      const availableViews = this._views.value;
      if (initialHash === 'config' || (availableViews && availableViews[initialHash])) {
        setActiveWorkspaceTab(initialHash);
      }
    }

    // 2. React to Browser Back/Forward buttons (History navigation)
    window.addEventListener('hashchange', () => {
      const currentHash = window.location.hash.replace(/^#\/?/, '');
      if (currentHash && currentHash !== this._activeWorkspaceTab.value) {
        setActiveWorkspaceTab(currentHash);
      }
    });

    // 3. React to state updates: Sync store back to URL bar
    store.namespace<ShellState>('shell').subscribe('activeWorkspaceTab', (tab) => {
      const normalizedHash = window.location.hash.replace(/^#\/?/, '');
      if (tab && tab !== 'none' && tab !== normalizedHash) {
        window.location.hash = `/${tab}`;
      } else if (tab === 'none' && normalizedHash !== '') {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      this._switchModeForTab(tab);
    });

    // 4. Listen for dynamic plugin shell actions (custom event bubbles)
    this.addEventListener('shell-action', (e: Event) => {
      const { action, id } = (e as CustomEvent).detail;
      if (action === 'openView') openView(id);
      else if (action === 'closeView') closeView(id);
    });
  }

  private _switchModeForTab(tabId: string | undefined) {
    if (!tabId) return;
    if (tabId === 'none' || tabId === 'config' || tabId === 'observe') {
      switchMode('chatbot');
      return;
    }
    const cfg = pluginHost().getViewConfig(tabId);
    if (cfg && cfg.modes && cfg.modes.length > 0) {
      switchMode(cfg.modes[0]!);
    }  
  }

  private async _bootstrap() {
    try {
      const res = await fetch(new URL('me', location.href));
      if (res.ok) {
        const { userId, roles } = await res.json();
        store.namespace<ShellState>('shell').set('currentUserId', userId);
        store.namespace<ShellState>('shell').set('currentUserRoles', roles ?? []);
      }
    } catch (e) {
      console.error('Failed to fetch user session', e);
    }

    onMessage(dispatchFrame);
    connect();

    // Align restored open views with any persisted tab order.
    reconcileWorkspaceTabOrder();

    // In the new layout, chat is always a persistent sidebar and never a dock window.
  }

  private _canUseAdminSurface() {
    const roles = this._currentUserRoles.value as string[] | undefined;
    const userId = this._currentUserId.value;
    return userId === 'anonymous' || (roles?.includes('admin') ?? false);
  }

  private async _handleLogout() {
    await logout();
  }

  private _isAnyWorkspaceOpen() {
    const views = this._views.value;
    return views ? Object.keys(views).some(id => views[id]?.isOpen) : false;
  }

  private _getActiveWorkspaces() {
    const views = this._views.value ?? {};
    const order = (this._workspaceTabOrder.value as string[] | undefined) ?? [];
    const ordered = order.filter(id => views[id]?.isOpen);
    for (const id of Object.keys(views)) {
      if (views[id]?.isOpen && !ordered.includes(id)) ordered.push(id);
    }
    return ordered;
  }

  private _clearDragState() {
    this._draggingTabId = null;
    this._dropTargetId = null;
    this._dropPlace = 'before';
  }

  private _onTabDragStart(e: DragEvent, id: string) {
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('.tab-close')) {
      e.preventDefault();
      return;
    }
    this._didDrag = true;
    this._draggingTabId = id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(TAB_DND_MIME, id);
      // Some browsers require a text/plain payload for drag to proceed.
      e.dataTransfer.setData('text/plain', id);
    }
  }

  private _onTabDragOver(e: DragEvent, id: string) {
    if (!this._draggingTabId || this._draggingTabId === id) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const place: 'before' | 'after' =
      e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    this._dropTargetId = id;
    this._dropPlace = place;
  }

  private _onTabDragLeave(e: DragEvent, id: string) {
    if (this._dropTargetId !== id) return;
    const related = e.relatedTarget as Node | null;
    const current = e.currentTarget as Node;
    if (related && current.contains(related)) return;
    this._dropTargetId = null;
  }

  private _onTabDrop(e: DragEvent, targetId: string) {
    e.preventDefault();
    const draggedId =
      e.dataTransfer?.getData(TAB_DND_MIME) ||
      e.dataTransfer?.getData('text/plain') ||
      this._draggingTabId;
    if (!draggedId || draggedId === targetId) {
      this._clearDragState();
      return;
    }

    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const place: 'before' | 'after' =
      this._dropTargetId === targetId
        ? this._dropPlace
        : e.clientX < rect.left + rect.width / 2
          ? 'before'
          : 'after';

    reorderWorkspaceTabs(draggedId, targetId, place);
    this._clearDragState();
  }

  private _onTabDragEnd() {
    this._clearDragState();
    // Allow a microtask so a spurious click after drag is suppressed.
    queueMicrotask(() => {
      this._didDrag = false;
    });
  }

  private _onTabClick(id: string) {
    if (this._didDrag) {
      this._didDrag = false;
      return;
    }
    setActiveWorkspaceTab(id);
  }

  private _handleSidebarResize(e: PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = this._sidebarWidth.value;

    const onPointerMove = (moveEv: PointerEvent) => {
      const dx = moveEv.clientX - startX;
      const newWidth = Math.max(260, Math.min(window.innerWidth / 2, startWidth + dx));
      store.namespace<ShellState>('shell').set('sidebarWidth', newWidth);
    };

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  private _toggleSidebar() {
    this._isSidebarCollapsed = !this._isSidebarCollapsed;
  }

  override updated(changedProperties: Map<string | symbol, unknown>) {
    super.updated(changedProperties);

    const isWaiting = this._isWaiting.value as boolean;
    if (isWaiting && !this._prevWaiting) {
      this._noticing = true;
      setTimeout(() => { this._noticing = false; }, 700);
    }
    this._prevWaiting = isWaiting;

  }

  override render() {
    const canAdmin = this._canUseAdminSurface();
    const isWaiting = this._isWaiting.value;
    const userId = this._currentUserId.value;

    return html`
      <header class="${isWaiting ? 'streaming' : ''}">
        <div class="logo">
          <svg class="logo-mark ${this._noticing ? 'noticing' : ''}" viewBox="0 0 24 24" fill="none">
            <path d="M12 2.5 C10.5 4.5 8.5 5.5 6.5 7 C4.8 8.2 4 9.8 4 12 C4 14.2 5 15.8 6.8 17 C8.6 18.2 10.5 19.2 12 21.5 C13.5 19.2 15.4 18.2 17.2 17 C19 15.8 20 14.2 20 12 C20 9.8 19.2 8.2 17.5 7 C15.5 5.5 13.5 4.5 12 2.5Z" fill="currentColor" opacity="0.18"/>
            <path d="M12 6.5 C11 7.8 9.5 8.8 8.2 9.8 C7 10.8 6.5 11.3 6.5 12 C6.5 12.7 7 13.2 8.2 14.2 C9.5 15.2 11 16.2 12 17.5 C13 16.2 14.5 15.2 15.8 14.2 C17 13.2 17.5 12.7 17.5 12 C17.5 11.3 17 10.8 15.8 9.8 C14.5 8.8 13 7.8 12 6.5Z" fill="currentColor" opacity="0.55"/>
            <circle cx="12" cy="12" r="1.6" fill="currentColor" opacity="0.9"/>
          </svg>
          <span class="logo-name">RORSCHACH</span>
          <div class="header-actions-group">
            <button class="header-icon-btn" @click=${this._toggleSidebar} title="Toggle sidebar">
              <r-icon name=${this._isSidebarCollapsed ? 'panel-left-open' : 'panel-left-close'}></r-icon>
            </button>
            <button class="header-icon-btn" ?hidden=${!userId || userId === 'anonymous'} @click=${() => openView('auth.profile')} title="User Session Profile">
              <r-icon name="user"></r-icon>
            </button>
            <button class="header-icon-btn" ?hidden=${!canAdmin} @click=${() => openView('config')} title="Configuration Settings">
              <r-icon name="settings"></r-icon>
            </button>
            <button class="header-icon-btn" ?hidden=${!canAdmin || !this._views.value || !this._views.value['observe']} @click=${() => openView('observe')} title="Observation Panel">
              <r-icon name="activity" size="md"></r-icon>
            </button>
          </div>
          <div class="status-pill">
            <r-status-dot></r-status-dot>
          </div>
        </div>
        <div class="header-end">
          <r-agent-select></r-agent-select>
          <r-theme-select></r-theme-select>
          ${userId && userId !== 'anonymous' ? html`
            <button class="logout-btn" title="Sign out" @click=${this._handleLogout}>
              <r-icon name="logout"></r-icon>
            </button>
          ` : ''}
        </div>
      </header>

      <main class="split-pane-layout">
        <!-- Left Sidebar: Chat panel -->
        <aside class="sidebar-panel ${this._isSidebarCollapsed ? 'collapsed' : ''}" style="width: ${this._isSidebarCollapsed ? '0px' : `${this._sidebarWidth.value}px`};">
          <div class="sidebar-content-wrapper">
            <div class="sidebar-title-bar">
              <span class="sidebar-title">${this._currentModeDisplayName.value || this._currentMode.value || 'Chat'}</span>
            </div>
            
            <r-chat-panel class="flex-grow-1 min-height-0"></r-chat-panel>
          </div>
        </aside>

        <!-- Sidebar Resizer -->
        <div class="sidebar-resizer" ?hidden=${this._isSidebarCollapsed} @pointerdown=${this._handleSidebarResize}></div>

        <!-- Right Column: Workspaces -->
        <div class="workspace-panel flex-grow-1 flex-column min-width-0">
          <r-corona aria-hidden="true"></r-corona>
          ${this._isAnyWorkspaceOpen() ? html`
            <div class="workspace-container flex-grow-1 flex-column min-height-0">
              <div class="workspace-tabs-bar">
                <div class="tabs-list">
                  ${this._getActiveWorkspaces().map(id => {
                    const cfg = pluginHost().getViewConfig(id);
                    const isDragging = this._draggingTabId === id;
                    const isDropTarget = this._dropTargetId === id && this._draggingTabId && this._draggingTabId !== id;
                    const dropClass = isDropTarget
                      ? (this._dropPlace === 'before' ? 'drop-before' : 'drop-after')
                      : '';
                    return html`
                      <button
                        class="workspace-tab ${this._activeWorkspaceTab.value === id ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${dropClass}"
                        draggable="true"
                        aria-grabbed=${isDragging ? 'true' : 'false'}
                        @click=${() => this._onTabClick(id)}
                        @dragstart=${(e: DragEvent) => this._onTabDragStart(e, id)}
                        @dragover=${(e: DragEvent) => this._onTabDragOver(e, id)}
                        @dragleave=${(e: DragEvent) => this._onTabDragLeave(e, id)}
                        @drop=${(e: DragEvent) => this._onTabDrop(e, id)}
                        @dragend=${() => this._onTabDragEnd()}>
                        <r-icon name=${(cfg?.icon ?? 'file') as any} size="sm"></r-icon>
                        <span>${cfg?.title ?? id}</span>
                        <span class="tab-close"
                          draggable="false"
                          @click=${(e: Event) => {
                            e.stopPropagation();
                            closeView(id);
                          }}
                          @dragstart=${(e: Event) => e.stopPropagation()}>×</span>
                      </button>
                    `;
                  })}
                </div>
              </div>
              <div class="workspace-active-body flex-grow-1 min-height-0">
                <r-view .viewId=${this._activeWorkspaceTab.value as string}></r-view>
              </div>
            </div>
          ` : html`
            <div class="workspace-empty-container flex-grow-1">
              <r-welcome-dashboard class="flex-grow-1"></r-welcome-dashboard>
            </div>
          `}
        </div>
      </main>
    `;
  }
}
