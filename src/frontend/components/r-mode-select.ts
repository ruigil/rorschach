import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { store } from '../store.js';
import { switchMode } from '../session.js';
import type { Agent } from '../types/state.js';

@customElement('r-mode-select')
export class RModeSelect extends RorschachBase {
  @state() private _agents: Agent[] = [];
  @state() private _currentMode = '';
  @state() private _currentModeDisplayName = '';
  @state() private _isConnected = false;
  @state() private _isWaiting = false;

  private _unsubs: (() => void)[] = [];

  // We render to the light DOM to use the global shell.css styles
  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this._unsubs = [
      store.subscribe('agents', (val) => this._agents = val),
      store.subscribe('currentMode', (val) => this._currentMode = val),
      store.subscribe('currentModeDisplayName', (val) => this._currentModeDisplayName = val),
      store.subscribe('isConnected', (val) => this._isConnected = val),
      store.subscribe('isWaiting', (val) => this._isWaiting = val),
    ];
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubs.forEach(unsub => unsub());
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
      this._isWaiting = true; 
    }
  }

  override render() {
    const agentList = this._agents.length > 0
      ? this._agents
      : this._currentMode ? [{ 
          mode: this._currentMode, 
          displayName: this._currentModeDisplayName || this._modeLabel(this._currentMode), 
          shortDesc: '' 
        }] : [];

    const isDisabled = !this._isConnected || this._isWaiting || agentList.length < 2;

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
        <select id="mode-select" ?disabled=${isDisabled} @change=${this._handleChange}>
          ${agentList.map(agent => html`
            <option 
              value=${agent.mode} 
              ?selected=${agent.mode === this._currentMode} 
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
