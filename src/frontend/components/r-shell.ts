import { html } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { store, StoreController } from '../store.js';
import { connect } from '../connection.js';
import { logout, openWindow, closeWindow, setActiveWorkspaceTab, undockWindow } from '../actions.js';
import { TABS } from '../constants.js';
import type { Tab } from '../constants.js';
import { WINDOW_REGISTRY } from '../core/window-registry.js';

@customElement('r-shell')
export class RShell extends RorschachBase {
  private _activeTab = new StoreController(this, 'activeTab');
  private _isConnected = new StoreController(this, 'isConnected');
  private _currentUserId = new StoreController(this, 'currentUserId');
  private _currentUserRoles = new StoreController(this, 'currentUserRoles');
  private _isWaiting = new StoreController(this, 'isWaiting');

  private _windows = new StoreController(this, 'windows');
  private _activeWorkspaceTab = new StoreController(this, 'activeWorkspaceTab');
  private _currentMode = new StoreController(this, 'currentMode');
  private _currentDocArtifact = new StoreController(this, 'currentDocArtifact');
  private _currentWorkflowGraph = new StoreController(this, 'currentWorkflowGraph');

  private _lastMode = '';
  private _lastDocArtifact: string | null = null;
  private _lastWorkflowGraph: any = null;

  @state() private _noticing = false;
  private _prevWaiting = false;

  override createRenderRoot() {
    return this; // Light DOM to integrate globally
  }

  override connectedCallback() {
    super.connectedCallback();
    this._bootstrap();
  }

  private async _bootstrap() {
    try {
      const res = await fetch(new URL('me', location.href));
      if (res.ok) {
        const { userId, roles } = await res.json();
        store.set('currentUserId', userId);
        store.set('currentUserRoles', roles ?? []);
      }
    } catch (e) {
      console.error('Failed to fetch user session', e);
    }

    connect();

    if (store.get('activeTab') === 'chat') {
      openWindow('chat');
    }
  }

  private _canUseAdminSurface() {
    const roles = this._currentUserRoles.value as string[];
    const userId = this._currentUserId.value;
    return userId === 'anonymous' || roles.includes('admin');
  }

  private _handleTabClick(tab: Tab) {
    store.set('activeTab', tab);
    if (tab === 'chat') {
      openWindow('chat');
    }
  }

  private async _handleLogout() {
    await logout();
  }

  private _undockWorkspace(id: string) {
    undockWindow(id);
  }

  private _isAnyWorkspaceDockedAndOpen() {
    const windows = this._windows.value as any;
    return Object.keys(windows).some(id => id !== 'chat' && windows[id].isOpen && windows[id].isDocked);
  }

  private _getActiveDockedWorkspaces() {
    const windows = this._windows.value as any;
    return Object.keys(windows).filter(id => id !== 'chat' && windows[id].isOpen && windows[id].isDocked);
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
    const dockedOpenWorkspaces = this._getActiveDockedWorkspaces();
    if (dockedOpenWorkspaces.length > 0 && !dockedOpenWorkspaces.includes(activeTab)) {
      const fallback = dockedOpenWorkspaces[0]!;
      setActiveWorkspaceTab(fallback);
    }

    // Sync workspaces open states based on modes, artifacts, and graphs
    const mode = this._currentMode.value as string;
    if (mode !== this._lastMode) {
      const isInitialLoad = this._lastMode === '';
      this._lastMode = mode;
      if (mode === 'workflows') {
        openWindow('workflows');
      } else if (!isInitialLoad) {
        closeWindow('workflows');
      }
    }

    const artifact = this._currentDocArtifact.value as string | null;
    if (artifact !== this._lastDocArtifact) {
      this._lastDocArtifact = artifact;
      if (artifact) {
        openWindow('docs', { currentDocArtifact: artifact });
      }
    }

    const workflowGraph = this._currentWorkflowGraph.value as any;
    if (workflowGraph !== this._lastWorkflowGraph) {
      this._lastWorkflowGraph = workflowGraph;
      if (workflowGraph && (workflowGraph.workflowId || (workflowGraph.nodes && workflowGraph.nodes.length))) {
        openWindow('workflows');
      }
    }
  }

  override render() {
    const activeTab = this._activeTab.value;
    const canAdmin = this._canUseAdminSurface();
    const isConnected = this._isConnected.value;
    const isWaiting = this._isWaiting.value;
    const userId = this._currentUserId.value;
    const windows = this._windows.value as any;

    return html`
      <header class="${isWaiting ? 'streaming' : ''}">
        <div class="logo">
          <svg class="logo-mark ${this._noticing ? 'noticing' : ''}" viewBox="0 0 24 24" fill="none">
            <path d="M12 2.5 C10.5 4.5 8.5 5.5 6.5 7 C4.8 8.2 4 9.8 4 12 C4 14.2 5 15.8 6.8 17 C8.6 18.2 10.5 19.2 12 21.5 C13.5 19.2 15.4 18.2 17.2 17 C19 15.8 20 14.2 20 12 C20 9.8 19.2 8.2 17.5 7 C15.5 5.5 13.5 4.5 12 2.5Z" fill="currentColor" opacity="0.18"/>
            <path d="M12 6.5 C11 7.8 9.5 8.8 8.2 9.8 C7 10.8 6.5 11.3 6.5 12 C6.5 12.7 7 13.2 8.2 14.2 C9.5 15.2 11 16.2 12 17.5 C13 16.2 14.5 15.2 15.8 14.2 C17 13.2 17.5 12.7 17.5 12 C17.5 11.3 17 10.8 15.8 9.8 C14.5 8.8 13 7.8 12 6.5Z" fill="currentColor" opacity="0.55"/>
            <circle cx="12" cy="12" r="1.6" fill="currentColor" opacity="0.9"/>
          </svg>
          <span class="logo-name">RORSCHACH</span>
          <div class="logo-divider"></div>
          <span class="logo-sub">${activeTab}</span>
        </div>
        <nav class="header-nav">
          <button class="nav-link ${activeTab === 'chat' ? 'active' : ''}" 
                  @click=${() => this._handleTabClick('chat')}>chat</button>
          <button class="nav-link ${activeTab === 'config' ? 'active' : ''}" 
                  ?hidden=${!canAdmin}
                  @click=${() => this._handleTabClick('config')}>config</button>
          <button class="nav-link ${activeTab === 'observe' ? 'active' : ''}" 
                  ?hidden=${!canAdmin}
                  @click=${() => this._handleTabClick('observe')}>observe</button>
        </nav>
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

      <main>
        <div id="panel-chat" class="panel ${activeTab === 'chat' ? 'active' : ''} ${this._isAnyWorkspaceDockedAndOpen() ? 'workspaces-open' : ''}">
          <!-- Left-Dock Slot: Chat Window -->
          ${windows.chat.isOpen && windows.chat.isDocked ? html`
            <r-window .windowId=${'chat'} class="chat-dock-slot"></r-window>
          ` : ''}

          <!-- Right-Dock Slot: Shared Tabbed Workspaces -->
          ${this._isAnyWorkspaceDockedAndOpen() ? html`
            <div class="workspace-dock-slot flex-column">
              <div class="workspace-tabs-bar">
                <div class="tabs-list">
                  ${this._getActiveDockedWorkspaces().map(id => html`
                    <button 
                      class="workspace-tab ${this._activeWorkspaceTab.value === id ? 'active' : ''}" 
                      @click=${() => setActiveWorkspaceTab(id)}
                    >
                      ${this.renderIcon((WINDOW_REGISTRY[id]?.icon ?? 'file') as any)}
                      <span>${WINDOW_REGISTRY[id]?.title ?? id}</span>
                      <span class="tab-close" @click=${(e: Event) => {
                        e.stopPropagation();
                        closeWindow(id);
                      }}>×</span>
                    </button>
                  `)}
                </div>

                <div class="workspace-tabs-actions">
                  <button class="win-btn tab-action-btn" @click=${() => this._undockWorkspace(this._activeWorkspaceTab.value as string)} title="Undock to floating window">
                    ${this.renderIcon('popup')}
                  </button>
                  <button class="win-btn tab-action-btn close-btn" @click=${() => closeWindow(this._activeWorkspaceTab.value as string)} title="Close workspace">
                    ×
                  </button>
                </div>
              </div>
              <div class="workspace-active-body flex-grow-1 min-height-0">
                <r-window .windowId=${this._activeWorkspaceTab.value as string}></r-window>
              </div>
            </div>
          ` : ''}
        </div>

        <div id="panel-config" class="panel ${activeTab === 'config' ? 'active' : ''}">
          <r-config-form></r-config-form>
        </div>

        <div id="panel-observe" class="panel ${activeTab === 'observe' ? 'active' : ''}">
          <r-observe-panel></r-observe-panel>
        </div>
      </main>

      <!-- Floating Windows Layer -->
      <div class="floating-window-layer">
        ${Object.keys(windows).map(id => {
          const win = windows[id];
          return win.isOpen && !win.isDocked ? html`
            <r-window .windowId=${id}></r-window>
          ` : '';
        })}
      </div>
    `;
  }
}
