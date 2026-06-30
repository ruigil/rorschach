import { html, css } from 'lit';
import { customElement, state, property } from 'lit/decorators.js';
import { RorschachBase, tsStr } from './base.js';
import { store } from './store.js';
import { StoreController } from './store-controller.js';
import type { LogEvent } from './types.js';

type ShellLogsState = {
  logs: LogEvent[]
};

@customElement('r-log-stream')
export class RLogStream extends RorschachBase {
  @property({ type: Array }) logs?: LogEvent[];

  private _logs = new StoreController<ShellLogsState, 'logs'>(this, ['shell', 'logs']);

  static override styles = css`
    :host {
      display: block;
      flex: 1;
      overflow-y: auto;
      padding: 0.75rem 0;
      font-family: var(--font-mono);
      font-size: 0.775rem;
      font-weight: 300;
    }
    :host::-webkit-scrollbar { width: 3px; }
    :host::-webkit-scrollbar-track { background: transparent; }
    :host::-webkit-scrollbar-thumb { background: var(--border-mid); border-radius: 2px; }
    .log-entry {
      display: grid;
      grid-template-columns: 80px 42px 1fr;
      align-items: baseline;
      gap: 0.6rem;
      padding: 0.4rem 0.7rem;
      transition: background 0.1s;
      animation: logIn 0.15s ease both;
    }
    .log-entry:hover { background: var(--accent-dim); }
    @keyframes logIn {
      from { opacity: 0; transform: translateX(-4px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    .log-ts { color: var(--text-dim); font-size: 0.72rem; letter-spacing: -0.02em; white-space: nowrap; }
    .log-level {
      font-size: 0.62rem;
      font-weight: 500;
      letter-spacing: 0.08em;
      text-align: center;
      padding: 0.1rem 0;
      border-radius: 3px;
    }
    .log-level.debug { color: var(--log-debug); }
    .log-level.info  { color: var(--log-info); }
    .log-level.warn  { color: var(--log-warn); }
    .log-level.error { color: var(--log-error); }
    .log-body { line-height: 1.5; }
    .log-source { color: var(--accent); margin-right: 0.4rem; font-size: 0.72rem; }
    .log-msg.debug { color: var(--log-debug); }
    .log-msg.info  { color: var(--text); }
    .log-msg.warn  { color: var(--log-warn); }
    .log-msg.error { color: var(--log-error); }
    .log-data { display: block; margin-top: 0.1rem; color: var(--text-dim); font-size: 0.7rem; }
  `;

  get count() {
    return this.logs !== undefined ? this.logs.length : this._logs.value.length;
  }

  clear() {
    if (this.logs === undefined) {
      store.namespace<ShellLogsState>('shell').set('logs', []);
    }
    return 0;
  }

  override render() {
    const logs = this.logs !== undefined ? this.logs : this._logs.value;
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
