import {
  customElement,
  html,
  RorschachBase,
  store,
  StoreController
} from '@rorschach/webkit';

import { switchMode } from './actions.js';
import type { ShellState } from './types.js';

@customElement('r-mode-select')
export class RModeSelect extends RorschachBase {
  private _agents = new StoreController(this, ['shell', 'agents']);
  private _currentMode = new StoreController(this, ['shell', 'currentMode']);
  private _currentModeDisplayName = new StoreController(this, ['shell', 'currentModeDisplayName']);
  private _isConnected = new StoreController(this, ['shell', 'isConnected']);
  private _isWaiting = new StoreController(this, ['shell', 'isWaiting']);

  // We render to the light DOM to use the global shell.css styles
  override createRenderRoot() {
    return this;
  }

  private _handleChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    if (switchMode(select.value)) {
      // Temporarily disable while switching
      store.namespace<ShellState>('shell').set('isWaiting', true);
    }
  }

  override render() {
    const agents = this._agents.value;
    const currentMode = this._currentMode.value;
    const currentModeDisplayName = this._currentModeDisplayName.value;
    const isConnected = this._isConnected.value;
    const isWaiting = this._isWaiting.value;

    const agentList = agents.length > 0
      ? agents
      : currentMode ? [{
          mode: currentMode,
          displayName: currentModeDisplayName,
          shortDesc: ''
        }] : [];

    const isDisabled = !isConnected || isWaiting || agentList.length < 2;

    if (agentList.length === 0) {
      return html`
        <label class="header-select-wrap" for="mode-select">
          <span>mode</span>
          <select id="mode-select" class="header-select" disabled>
            <option value="">loading</option>
          </select>
        </label>
      `;
    }

    return html`
      <label class="header-select-wrap" for="mode-select">
        <span>mode</span>
        <select id="mode-select" class="header-select" .value=${currentMode} ?disabled=${isDisabled} @change=${this._handleChange}>
          ${agentList.map(agent => html`
            <option
               value=${agent.mode}
               ?selected=${agent.mode === currentMode}
               .title=${agent.shortDesc || ''}
            >
               ${agent.displayName}
            </option>
          `)}
        </select>
      </label>
    `;
  }
}
