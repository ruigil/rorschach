import { html, css } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { RorschachBase } from './base.js'

// Generic event log primitive. Renders a list of timestamped events.
// Used by the workflow inspector's events tab. Accepts clean, decoupled
// data — no workflow-specific types.

export interface EventLogEntry {
  timestamp: string
  type: string
  taskId?: string
  message: string
}

@customElement('r-event-log')
export class REventLog extends RorschachBase {
  @property({ type: Array }) events: EventLogEntry[] = []
  @property({ type: String }) emptyText = 'No events available.'

  static override styles = css`
    :host { display: block; }
    .event-list { display: flex; flex-direction: column; gap: 2px; max-height: 100%; overflow-y: auto; }
    .event-row { display: flex; gap: 0.5rem; align-items: baseline; font-size: 0.72rem; }
    .event-time { color: var(--text-dim, #3d6878); font-family: var(--font-mono, monospace); white-space: nowrap; }
    .event-type { color: var(--accent, #00c4d4); min-width: 80px; }
    .event-message { color: var(--text-mid, #8abccc); flex: 1; }
    .event-empty { color: var(--text-dim, #3d6878); font-size: 0.75rem; padding: 1rem; text-align: center; }
  `

  private _formatTime(timestamp: string): string {
    const date = new Date(timestamp)
    return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleTimeString()
  }

  override render() {
    if (!this.events.length) {
      return html`<div class="event-empty">${this.emptyText}</div>`
    }
    return html`
      <div class="event-list">
        ${this.events.map(event => html`
          <div class="event-row">
            <span class="event-time">${this._formatTime(event.timestamp)}</span>
            <span class="event-type">${event.type}</span>
            <span class="event-message">
              ${event.taskId ? html`<strong>${event.taskId}</strong> ` : ''}
              ${event.message}
            </span>
          </div>
        `)}
      </div>
    `
  }
}
