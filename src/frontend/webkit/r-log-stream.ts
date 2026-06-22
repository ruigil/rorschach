import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { RorschachBase, tsStr } from './base.js';
import { store } from './store.js';
import { StoreController } from './store-controller.js';
import type { LogEvent } from './types.js';

interface ShellLogsState {
  logs: LogEvent[]
}

@customElement('r-log-stream')
export class RLogStream extends RorschachBase {
  private _logs = new StoreController<ShellLogsState, 'logs'>(this, ['shell', 'logs']);

  // Render to light DOM to reuse shell/observe styles
  override createRenderRoot() {
    return this;
  }

  get count() {
    return this._logs.value.length;
  }

  clear() {
    store.namespace<ShellLogsState>('shell').set('logs', []);
    return 0;
  }

  override render() {
    const logs = this._logs.value;
    if (logs.length === 0) {
      return html`
        <r-empty-state 
          variant="panel" 
          name="terminal" 
          text="awaiting log events"
        ></r-empty-state>
      `;
    }

    return html`
      ${logs.map(event => {
        const level = event.level || 'info';
        const dataStr = event.data !== undefined ? JSON.stringify(event.data) : '';
        
        return html`
          <div class="log-entry">
            <span class="log-ts">${tsStr(event.timestamp || Date.now())}</span>
            <span class="log-level ${level}">${level.toUpperCase()}</span>
            <span class="log-body">
              <span class="log-source">[${event.source || '?'}]</span>
              <span class="log-msg ${level}">${event.message || ''}</span>
              ${dataStr ? html`<span class="log-data">${dataStr}</span>` : ''}
            </span>
          </div>
        `;
      })}
    `;
  }
}
