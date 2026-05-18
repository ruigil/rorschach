import { RorschachElement } from './base.js'

const CSS = `
:host {
  display: block;
}

.attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.attachment {
  border-radius: 6px;
  overflow: hidden;
  background: var(--bg-secondary, rgba(255,255,255,0.03));
}

.attachment-image {
  max-width: 200px;
  max-height: 150px;
  display: block;
  border-radius: 4px;
}

.attachment-audio {
  display: block;
  max-width: 250px;
}

.attachment-video {
  max-width: 250px;
  max-height: 180px;
  display: block;
  border-radius: 4px;
}

.attachment-file {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.6rem;
  color: var(--accent, #7aa2f7);
  text-decoration: none;
  font-size: 0.78rem;
}

.attachment-file:hover {
  text-decoration: underline;
}

.attachment-caption {
  font-size: 0.7rem;
  color: var(--muted, #8a8a8a);
  padding: 0.2rem 0.4rem;
}
`

export class RAttachments extends RorschachElement {
  constructor() {
    super()
    this.loadStyles(CSS)
  }

  render(attachments) {
    if (!attachments || attachments.length === 0) {
      this.shadowRoot.innerHTML = ''
      return
    }

    this.shadowRoot.innerHTML = `
      <div class="attachments">
        ${attachments.map(a => {
    if (a.kind === 'image') {
      return `
            <div class="attachment attachment-image">
              <img src="${this.constructor.escHtml(a.url)}" class="attachment-image" ${a.alt ? `alt="${this.constructor.escHtml(a.alt)}"` : ''}>
            </div>
          `
    } else if (a.kind === 'audio') {
      return `
            <div class="attachment attachment-audio">
              <audio src="${this.constructor.escHtml(a.url)}" controls class="attachment-audio"></audio>
              ${a.alt ? `<div class="attachment-caption">${this.constructor.escHtml(a.alt)}</div>` : ''}
            </div>
          `
    } else if (a.kind === 'video') {
      return `
            <div class="attachment attachment-video">
              <video src="${this.constructor.escHtml(a.url)}" controls class="attachment-video"></video>
              ${a.alt ? `<div class="attachment-caption">${this.constructor.escHtml(a.alt)}</div>` : ''}
            </div>
          `
    } else {
      return `
            <div class="attachment attachment-file">
              <a href="${this.constructor.escHtml(a.url)}" target="_blank" rel="noopener noreferrer" class="attachment-file">
                ${this.constructor.escHtml(a.alt || a.url.split('/').pop() || 'file')}
              </a>
            </div>
          `
    }
  }).join('')}
      </div>
    `
  }
}

if (!customElements.get('r-attachments')) {
  customElements.define('r-attachments', RAttachments)
}
