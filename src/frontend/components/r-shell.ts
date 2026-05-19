import { html } from 'lit';
import { customElement, query } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { store, StoreController } from '../store.js';
import { connect } from '../connection.js';
import { initSession } from '../session.js';

@customElement('r-shell')
export class RShell extends RorschachBase {
  private _activeTab = new StoreController(this, 'activeTab');
  private _isConnected = new StoreController(this, 'isConnected');
  private _currentUserId = new StoreController(this, 'currentUserId');
  private _currentUserRoles = new StoreController(this, 'currentUserRoles');
  private _isWaiting = new StoreController(this, 'isWaiting');

  @query('r-chat-panel') private _chatPanel?: any;

  // We use light DOM to reuse the existing shell styles from style.css
  override createRenderRoot() {
    return this;
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
        
        // Initial schema load if admin
        if (this._canUseAdminSurface()) {
          (this.querySelector('r-config-form') as any)?.loadSchemas();
        }
      }
    } catch (e) {
      console.error('Failed to fetch user session', e);
    }

    initSession();
    connect();
  }

  private _canUseAdminSurface() {
    const roles = this._currentUserRoles.value as string[];
    const userId = this._currentUserId.value;
    return userId === 'anonymous' || roles.includes('admin');
  }

  private _handleTabClick(tab: string) {
    store.set('activeTab', tab);
    if (tab === 'chat') {
      this._chatPanel?.focus();
    }
  }

  private async _handleLogout() {
    await fetch(new URL('auth/logout', location.href), { method: 'POST' });
    window.location.href = new URL('auth/login.html', location.href).href;
  }

  override render() {
    const activeTab = this._activeTab.value;
    const canAdmin = this._canUseAdminSurface();
    const isConnected = this._isConnected.value;
    const isWaiting = this._isWaiting.value;
    const userId = this._currentUserId.value;

    return html`
      <header class="${isWaiting ? 'streaming' : ''}">
        <div class="logo">
          <svg class="logo-mark" viewBox="0 0 24 24" fill="none">
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
        <div id="panel-chat" class="panel ${activeTab === 'chat' ? 'active' : ''}">
          <r-chat-panel></r-chat-panel>
          <r-plan-workspace id="plan-workspace"></r-plan-workspace>
        </div>

        <div id="panel-config" class="panel ${activeTab === 'config' ? 'active' : ''}">
          <r-config-form></r-config-form>
        </div>

        <div id="panel-observe" class="panel ${activeTab === 'observe' ? 'active' : ''}">
          <r-observe-panel></r-observe-panel>
        </div>
      </main>
    `;
  }
}
