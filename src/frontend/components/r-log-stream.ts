import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { RorschachBase, tsStr } from './base.js';
import type { LogEvent } from '../types/state.js';

const MAX_LOGS = 500;

@customElement('r-log-stream')
export class RLogStream extends RorschachBase {
  @state() private _logs: LogEvent[] = [];

  // Render to light DOM to reuse shell/observe styles
  override createRenderRoot() {
    return this;
  }

  get count() {
    return this._logs.length;
  }

  appendEvent(event: LogEvent) {
    this._logs = [event, ...this._logs].slice(0, MAX_LOGS);
    return this._logs.length;
  }

  clear() {
    this._logs = [];
    return 0;
  }

  override render() {
    if (this._logs.length === 0) {
      return html`
        <r-empty-state 
          variant="panel" 
          name="terminal" 
          text="awaiting log events"
        ></r-empty-state>
      `;
    }

    return html`
      ${this._logs.map(event => {
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
