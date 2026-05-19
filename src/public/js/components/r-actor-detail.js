import { LightElement, escHtml, defineElement } from './base.js'

export class RActorDetail extends LightElement {
  show(actor) {
    if (!actor) {
      this.innerHTML = `<r-empty-state variant="panel" name="eye" text="select an actor to inspect"></r-empty-state>`
      return
    }

    const status = actor.status || 'running'
    const failed = actor.messagesFailed ?? 0
    const avg    = typeof actor.processingTime?.avg === 'number' ? actor.processingTime.avg.toFixed(2) : '—'
    const min    = typeof actor.processingTime?.min === 'number' ? actor.processingTime.min.toFixed(2) : '—'
    const max    = typeof actor.processingTime?.max === 'number' ? actor.processingTime.max.toFixed(2) : '—'

    const parts = actor.name.split('/')
    const breadcrumb = parts.map((p, i) =>
      i < parts.length - 1
        ? `<span class="crumb">${escHtml(p)}</span><span class="crumb-sep">/</span>`
        : `<span class="crumb active">${escHtml(p)}</span>`
    ).join('')

    const stateSection = actor.state !== undefined && actor.state !== null
      ? `<div class="detail-section-label">state</div>
         <pre class="detail-state">${escHtml(JSON.stringify(actor.state, null, 2))}</pre>`
      : ''

    this.innerHTML = `
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
        <div class="detail-stat${failed > 0 ? ' error' : ''}">
          <span class="ds-val${failed > 0 ? ' error' : ''}">${failed}</span>
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
    `
  }
}

defineElement('r-actor-detail', RActorDetail)
