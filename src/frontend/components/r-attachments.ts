import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { type Attachment } from '../types/state.js';

@customElement('r-attachments')
export class RAttachments extends RorschachBase {
  @property({ type: Array }) items: Attachment[] = [];

  static override styles = css`
    :host {
      display: block;
      margin-bottom: 0.35rem;
      white-space: normal;
    }

    .attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
    }

    .attachment {
      border-radius: 6px;
      overflow: hidden;
      background: var(--bg-secondary, rgba(255,255,255,0.03));
    }

    .attachment-image {
      width: 100%;
      max-width: 100%;
      max-height: 450px;
      object-fit: contain;
      background: rgba(0, 0, 0, 0.15);
      display: block;
      border-radius: 4px;
    }

    .attachment-audio {
      display: block;
      max-width: 250px;
    }

    .attachment-video {
      width: 100%;
      max-width: 100%;
      max-height: 450px;
      background: rgba(0, 0, 0, 0.15);
      display: block;
      border-radius: 4px;
    }

    .attachment-file, .attachment-pdf {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.4rem 0.6rem;
      color: var(--accent, #7aa2f7);
      text-decoration: none;
      font-size: 0.78rem;
    }

    .attachment-file:hover, .attachment-pdf:hover {
      text-decoration: underline;
    }

    .attachment-caption {
      font-size: 0.7rem;
      color: var(--muted, #8a8a8a);
      padding: 0.2rem 0.4rem;
    }
    
    .attachment-pdf svg {
      flex-shrink: 0;
    }
  `;

  override render() {
    if (!this.items || this.items.length === 0) return html``;

    return html`
      <div class="attachments">
        ${this.items.map(a => this.renderAttachment(a))}
      </div>
    `;
  }

  private renderAttachment(a: Attachment) {
    const src = a.url || a.data || '';
    if (a.kind === 'image') {
      return html`
        <div class="attachment attachment-image">
          <img src="${src}" class="attachment-image" alt="${a.name || ''}">
        </div>
      `;
    } else if (a.kind === 'audio') {
      return html`
        <div class="attachment attachment-audio">
          <audio src="${src}" controls class="attachment-audio"></audio>
          ${a.name ? html`<div class="attachment-caption">${a.name}</div>` : ''}
        </div>
      `;
    } else if (a.kind === 'video') {
      return html`
        <div class="attachment attachment-video">
          <video src="${src}" controls class="attachment-video"></video>
          ${a.name ? html`<div class="attachment-caption">${a.name}</div>` : ''}
        </div>
      `;
    } else if (a.kind === 'pdf') {
      if (src) {
        return html`
          <a href="${src}" target="_blank" rel="noopener noreferrer" class="attachment attachment-pdf">
            ${this.renderIcon('file')}
            <span>${a.name || 'document.pdf'}</span>
          </a>
        `;
      }

      return html`
        <div class="attachment attachment-pdf">
          ${this.renderIcon('file')}
          <span>${a.name || 'document.pdf'}</span>
        </div>
      `;
    } else {
      return html`
        <div class="attachment attachment-file">
          <a href="${src}" target="_blank" rel="noopener noreferrer" class="attachment-file">
            ${a.name || src.split('/').pop() || 'file'}
          </a>
        </div>
      `;
    }
  }
}
