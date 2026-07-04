import { customElement, html, RorschachBase, StoreController } from '@rorschach/webkit';

import type { ShellState } from '../types/state.js';

@customElement('r-welcome-dashboard')
export class RWelcomeDashboard extends RorschachBase {
  private _currentModeDisplayName = new StoreController(this, ['shell', 'currentModeDisplayName']);
  private _currentMode = new StoreController(this, ['shell', 'currentMode']);

  override createRenderRoot() {
    return this; // Light DOM for global styles
  }

  override render() {
    const modeName = this._currentModeDisplayName.value || this._currentMode.value || 'None';

    return html`
      <div class="welcome-dashboard">
        <div class="welcome-hero">
          <svg class="welcome-logo" viewBox="0 0 24 24" fill="none">
            <path d="M12 2.5 C10.5 4.5 8.5 5.5 6.5 7 C4.8 8.2 4 9.8 4 12 C4 14.2 5 15.8 6.8 17 C8.6 18.2 10.5 19.2 12 21.5 C13.5 19.2 15.4 18.2 17.2 17 C19 15.8 20 14.2 20 12 C20 9.8 19.2 8.2 17.5 7 C15.5 5.5 13.5 4.5 12 2.5Z" fill="currentColor" opacity="0.18"/>
            <path d="M12 6.5 C11 7.8 9.5 8.8 8.2 9.8 C7 10.8 6.5 11.3 6.5 12 C6.5 12.7 7 13.2 8.2 14.2 C9.5 15.2 11 16.2 12 17.5 C13 16.2 14.5 15.2 15.8 14.2 C17 13.2 17.5 12.7 17.5 12 C17.5 11.3 17 10.8 15.8 9.8 C14.5 8.8 13 7.8 12 6.5Z" fill="currentColor" opacity="0.55"/>
            <circle cx="12" cy="12" r="1.6" fill="currentColor" opacity="0.9"/>
          </svg>
          <h1>RORSCHACH</h1>
          <p class="welcome-subtitle">Awaiting transmission · Void active</p>
        </div>

        <div class="welcome-cards">
          <div class="welcome-card mode-card">
            <div class="welcome-card-icon"><r-icon name="message-square"></r-icon></div>
            <div class="welcome-card-body">
              <h3>Active Mode</h3>
              <p class="welcome-mode-name">${modeName}</p>
              <p>Use the header mode selector to switch active agents.</p>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
