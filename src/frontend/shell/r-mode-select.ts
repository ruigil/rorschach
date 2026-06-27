import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { RorschachBase } from '@rorschach/frontend/webkit/base.js';
import { StoreController } from '@rorschach/frontend/webkit/store-controller.js';
import { store } from '@rorschach/frontend/webkit/store.js';
import { switchMode } from '../actions.js';
import type { ShellState, Agent } from '../types/state.js';

@customElement('r-mode-select')
export class RModeSelect extends RorschachBase {
  private _agents = new StoreController<ShellState, 'agents'>(this, ['shell', 'agents']);
  private _currentMode = new StoreController<ShellState, 'currentMode'>(this, ['shell', 'currentMode']);
  private _currentModeDisplayName = new StoreController<ShellState, 'currentModeDisplayName'>(this, ['shell', 'currentModeDisplayName']);
  private _isConnected = new StoreController<ShellState, 'isConnected'>(this, ['shell', 'isConnected']);
  private _isWaiting = new StoreController<ShellState, 'isWaiting'>(this, ['shell', 'isWaiting']);

  // We render to the light DOM to use the global shell.css styles
  override createRenderRoot() {
    return this;
  }

  private _modeLabel(mode: string, displayName = '') {
    if (displayName) return displayName;
    if (!mode) return 'Mode';
    return mode.charAt(0).toUpperCase() + mode.slice(1);
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
          displayName: currentModeDisplayName || this._modeLabel(currentMode),
          shortDesc: ''
        }] : [];

    const isDisabled = !isConnected || isWaiting || agentList.length < 2;

    if (agentList.length === 0) {
      return html`
        <label class="mode-select-wrap" for="mode-select">
          <span>mode</span>
          <select id="mode-select" disabled>
            <option value="">loading</option>
          </select>
        </label>
      `;
    }

    return html`
      <label class="mode-select-wrap" for="mode-select">
        <span>mode</span>
        <select id="mode-select" .value=${currentMode} ?disabled=${isDisabled} @change=${this._handleChange}>
          ${agentList.map(agent => html`
            <option
              value=${agent.mode}
              ?selected=${agent.mode === currentMode}
              .title=${agent.shortDesc || ''}
            >
              ${agent.displayName || this._modeLabel(agent.mode)}
            </option>
          `)}
        </select>
      </label>
    `;
  }
}
