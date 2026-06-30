import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import type { Actor } from './types.js';

@customElement('r-actor-detail')
export class RActorDetail extends RorschachBase {
  @property({ type: Object }) actor: Actor | null = null;

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      overflow-y: auto;
    }
    :host::-webkit-scrollbar { width: 3px; }
    :host::-webkit-scrollbar-track { background: transparent; }
    :host::-webkit-scrollbar-thumb { background: var(--border-mid); border-radius: 2px; }
    .detail-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1.25rem 1.5rem 0.75rem;
      flex-shrink: 0;
    }
    .detail-path {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      row-gap: 0.2rem;
    }
    .crumb {
      font-size: 0.78rem;
      font-family: var(--font-mono);
      color: var(--text-dim);
    }
    .crumb.active {
      font-size: 0.9rem;
      font-weight: 500;
      color: var(--text);
    }
    .crumb-sep {
      font-size: 0.78rem;
      color: var(--border-mid);
      padding: 0 0.08rem;
    }
    .detail-divider {
      height: 1px;
      background: var(--border);
      margin: 0.1rem 1.5rem 1.25rem;
      flex-shrink: 0;
    }
    .detail-section-label {
      font-size: 0.57rem;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--text-dim);
      padding: 1rem 1.5rem 0.55rem;
      flex-shrink: 0;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1px;
      background: var(--border);
      margin: 0 1.5rem;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      flex-shrink: 0;
    }
    .detail-grid.three { grid-template-columns: repeat(3, 1fr); }
    .detail-stat {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      padding: 1rem 1.1rem;
      background: var(--surface);
      transition: background 0.12s;
    }
    .detail-stat:hover { background: var(--surface-2); }
    .detail-stat.error { background: var(--error-bg); }
    .ds-val {
      font-size: 1.55rem;
      font-weight: 700;
      font-family: var(--font-mono);
      color: var(--text-mid);
      line-height: 1;
    }
    .ds-val.sm   { font-size: 1.05rem; }
    .ds-val.error { color: var(--error); }
    .ds-unit {
      font-size: 0.65rem;
      color: var(--text-dim);
      font-weight: 400;
    }
    .ds-key {
      font-size: 0.57rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text-dim);
    }
    .detail-state {
      font-family: var(--font-mono);
      font-size: 0.72rem;
      font-weight: 300;
      line-height: 1.6;
      color: var(--text-mid);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin: 0 1.5rem 1rem;
      padding: 0.85rem 1rem;
      overflow-x: hidden;
      white-space: pre-wrap;
      word-break: break-all;
      flex-shrink: 0;
    }
    .actor-status {
      font-size: 0.6rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      padding: 0.15rem 0.5rem;
      border-radius: 3px;
      flex-shrink: 0;
    }
    .actor-status.running { color: var(--green); background: var(--green-glow); }
    .actor-status.stopped { color: var(--text-dim); background: var(--border); }
    .actor-status.error   { color: var(--error); background: var(--error-bg); }
  `;

  override render() {
    if (!this.actor) {
      return html`<r-empty-state variant="panel" name="eye" text="select an actor to inspect"></r-empty-state>`;
    }

    const actor = this.actor;
    const status = actor.status || 'running';
    const failed = actor.messagesFailed ?? 0;
    const avg = typeof actor.processingTime?.avg === 'number' ? actor.processingTime.avg.toFixed(2) : '—';
    const min = typeof actor.processingTime?.min === 'number' ? actor.processingTime.min.toFixed(2) : '—';
    const max = typeof actor.processingTime?.max === 'number' ? actor.processingTime.max.toFixed(2) : '—';

    const parts = actor.name.split('/');
    const breadcrumb = parts.map((p: string, i: number) =>
      i < parts.length - 1
        ? html`<span class="crumb">${p}</span><span class="crumb-sep">/</span>`
        : html`<span class="crumb active">${p}</span>`
    );

    const stateSection = actor.state !== undefined && actor.state !== null
      ? html`
          <div class="detail-section-label">state</div>
          <pre class="detail-state">${JSON.stringify(actor.state, null, 2)}</pre>
        `
      : '';

    return html`
      <div class="detail-head">
        <div class="detail-path">${breadcrumb}</div>
        <span class="actor-status ${status}">${status}</span>
      </div>
      <div class="detail-divider"></div>
      <div class="detail-section-label">messages</div>
      <div class="detail-grid">
        <div class="detail-stat">
          <span class="ds-val">${actor.messagesReceived ?? 0}</span>
          <span class="ds-key">received</span>
        </div>
        <div class="detail-stat">
          <span class="ds-val">${actor.messagesProcessed ?? 0}</span>
          <span class="ds-key">processed</span>
        </div>
        <div class="detail-stat ${failed > 0 ? 'error' : ''}">
          <span class="ds-val ${failed > 0 ? 'error' : ''}">${failed}</span>
          <span class="ds-key">failed</span>
        </div>
        <div class="detail-stat">
          <span class="ds-val">${actor.mailboxSize ?? 0}</span>
          <span class="ds-key">mailbox</span>
        </div>
      </div>
      <div class="detail-section-label">processing time</div>
      <div class="detail-grid three">
        <div class="detail-stat">
          <span class="ds-val sm">${avg} <span class="ds-unit">ms</span></span>
          <span class="ds-key">average</span>
        </div>
        <div class="detail-stat">
          <span class="ds-val sm">${min} <span class="ds-unit">ms</span></span>
          <span class="ds-key">minimum</span>
        </div>
        <div class="detail-stat">
          <span class="ds-val sm">${max} <span class="ds-unit">ms</span></span>
          <span class="ds-key">maximum</span>
        </div>
      </div>
      ${stateSection}
    `;
  }
}
