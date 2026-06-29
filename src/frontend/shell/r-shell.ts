import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { RorschachBase } from '@rorschach/frontend/webkit/base.js';
import { StoreController } from '@rorschach/frontend/webkit/store-controller.js';
import { store } from '@rorschach/frontend/webkit/store.js';
import { connect } from '../connection.js';
import { logout } from '../actions.js';
import { openWindow, closeWindow, setActiveWorkspaceTab } from '@rorschach/frontend/webkit/window-actions.js';
import type { ShellState } from '../types/state.js';
import { pluginHost } from './plugin-host.js';

@customElement('r-shell')
export class RShell extends RorschachBase {
  private _activeTab = new StoreController<ShellState, 'activeTab'>(this, ['shell', 'activeTab']);
  private _isConnected = new StoreController<ShellState, 'isConnected'>(this, ['shell', 'isConnected']);
  private _currentUserId = new StoreController<ShellState, 'currentUserId'>(this, ['shell', 'currentUserId']);
  private _currentUserRoles = new StoreController<ShellState, 'currentUserRoles'>(this, ['shell', 'currentUserRoles']);
  private _isWaiting = new StoreController<ShellState, 'isWaiting'>(this, ['shell', 'isWaiting']);

  private _windows = new StoreController<ShellState, 'windows'>(this, ['shell', 'windows']);
  private _activeWorkspaceTab = new StoreController<ShellState, 'activeWorkspaceTab'>(this, ['shell', 'activeWorkspaceTab']);
  private _currentMode = new StoreController<ShellState, 'currentMode'>(this, ['shell', 'currentMode']);
  private _currentModeDisplayName = new StoreController<ShellState, 'currentModeDisplayName'>(this, ['shell', 'currentModeDisplayName']);

  @state() private _noticing = false;
  private _prevWaiting = false;

  @state() private _sidebarWidth = 360;
  @state() private _isSidebarCollapsed = false;

  override createRenderRoot() {
    return this; // Light DOM to integrate globally
  }

  override connectedCallback() {
    super.connectedCallback();
    this._bootstrap();

    // Listen to activeTab store updates to handle legacy URL hash routing
    store.namespace<ShellState>('shell').subscribe('activeTab', (tab) => {
      if (tab === 'config') {
        openWindow('config');
        setTimeout(() => store.namespace<ShellState>('shell').set('activeTab', 'chat'), 50);
      } else if (tab === 'observe') {
        openWindow('observe');
        setTimeout(() => store.namespace<ShellState>('shell').set('activeTab', 'chat'), 50);
      }
    });
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

    connect();

    // In the new layout, chat is always a persistent sidebar and never a dock window.
    // However, we call openWindow('chat') for backwards compatibility in window maps.
    openWindow('chat');
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
    const windows = this._windows.value as any;
    return Object.keys(windows).some(id => id !== 'chat' && windows[id].isOpen);
  }

  private _getActiveWorkspaces() {
    const windows = this._windows.value as any;
    return Object.keys(windows).filter(id => id !== 'chat' && windows[id].isOpen);
  }

  private _handleSidebarResize(e: PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = this._sidebarWidth;

    const onPointerMove = (moveEv: PointerEvent) => {
      const dx = moveEv.clientX - startX;
      const newWidth = Math.max(260, Math.min(600, startWidth + dx));
      this._sidebarWidth = newWidth;
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

    // Enforce selection of an active tab
    const activeTab = this._activeWorkspaceTab.value as string;
    const openWorkspaces = this._getActiveWorkspaces();
    if (openWorkspaces.length > 0 && !openWorkspaces.includes(activeTab)) {
      const fallback = openWorkspaces[0]!;
      setActiveWorkspaceTab(fallback);
    }
  }

  override render() {
    const canAdmin = this._canUseAdminSurface();
    const isConnected = this._isConnected.value;
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
        </div>
        <div class="header-end">
          <r-mode-select></r-mode-select>
          <div class="status-pill">
            <r-status-dot status="${isConnected ? 'connected' : 'disconnected'}"
                          label="${isConnected ? 'online' : 'connecting…'}"></r-status-dot>
          </div>
          ${userId && userId !== 'anonymous' ? html`
            <button class="logout-btn" title="Sign out" @click=${this._handleLogout}>
              <r-icon name="logout"></r-icon>
            </button>
          ` : ''}
        </div>
      </header>

      <main class="split-pane-layout">
        <!-- Left Sidebar: Chat panel -->
        <aside class="sidebar-panel ${this._isSidebarCollapsed ? 'collapsed' : ''}" style="width: ${this._isSidebarCollapsed ? '60px' : `${this._sidebarWidth}px`};">
          <div class="sidebar-content-wrapper">
            <div class="sidebar-title-bar">
              <div class="sidebar-actions-group">
                <button class="sidebar-header-btn" @click=${this._toggleSidebar} title="Toggle sidebar">
                  ${this.renderIcon(this._isSidebarCollapsed ? 'panel-left-open' : 'panel-left-close')}
                </button>
                <button class="sidebar-header-btn" @click=${() => alert(`User Session: ${userId || 'anonymous'}`)} title="User Session Profile">
                  ${this.renderIcon('user')}
                </button>
                <button class="sidebar-header-btn" ?hidden=${!canAdmin} @click=${() => openWindow('config')} title="Configuration Settings">
                  ${this.renderIcon('settings')}
                </button>
                <button class="sidebar-header-btn" ?hidden=${!canAdmin} @click=${() => openWindow('observe')} title="Observation Panel">
                  ${this.renderIcon('activity')}
                </button>
              </div>
              <span class="sidebar-title">${this._currentModeDisplayName.value || this._currentMode.value || 'Chat'}</span>
            </div>
            
            <r-chat-panel class="flex-grow-1 min-height-0"></r-chat-panel>
          </div>
        </aside>

        <!-- Sidebar Resizer -->
        <div class="sidebar-resizer" ?hidden=${this._isSidebarCollapsed} @pointerdown=${this._handleSidebarResize}></div>

        <!-- Right Column: Workspaces -->
        <div class="workspace-panel flex-grow-1 flex-column min-width-0">
          <canvas id="void-canvas" aria-hidden="true"></canvas>
          ${this._isAnyWorkspaceOpen() ? html`
            <div class="workspace-container flex-grow-1 flex-column min-height-0">
              <div class="workspace-tabs-bar">
                <div class="tabs-list">
                  ${this._getActiveWorkspaces().map(id => {
                    const cfg = pluginHost.windowRegistry.get(id);
                    return html`
                      <button
                        class="workspace-tab ${this._activeWorkspaceTab.value === id ? 'active' : ''}"
                        @click=${() => setActiveWorkspaceTab(id)}
                      >
                        ${this.renderIcon((cfg?.icon ?? 'file') as any)}
                        <span>${cfg?.title ?? id}</span>
                        <span class="tab-close" @click=${(e: Event) => {
                          e.stopPropagation();
                          closeWindow(id);
                        }}>×</span>
                      </button>
                    `;
                  })}
                </div>
              </div>
              <div class="workspace-active-body flex-grow-1 min-height-0">
                <r-window .windowId=${this._activeWorkspaceTab.value as string}></r-window>
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
