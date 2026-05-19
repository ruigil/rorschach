import { html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import type { Actor } from '../types/state.js';

@customElement('r-actor-detail')
export class RActorDetail extends RorschachBase {
  @property({ type: Object }) actor: Actor | null = null;

  // Render to light DOM to reuse shell/observe styles
  override createRenderRoot() {
    return this;
  }

  show(actor: Actor | null) {
    this.actor = actor;
  }

  override render() {
    if (!this.actor) {
      return html`<r-empty-state variant="panel" name="eye" text="select an actor to inspect"></r-empty-state>`;
    }

    const actor = this.actor as any; // Cast for additional fields not yet in interface
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
