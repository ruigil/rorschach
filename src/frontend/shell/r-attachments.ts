import {
  css,
  customElement,
  html,
  property,
  state,
  RorschachBase
} from '@rorschach/webkit';

import { type Attachment } from './types.js';

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
      background: var(--surface-2);
    }

    .attachment.attachment-image {
      width: 100%;
      max-width: 100%;
      flex: 0 0 100%;
      background: transparent;
    }

    img.attachment-image {
      width: 100%;
      height: auto;
      max-height: none;
      object-fit: contain;
      display: block;
      border-radius: var(--radius, 6px);
    }

    .attachment-video {
      width: 100%;
      max-width: 100%;
      max-height: 450px;
      background: var(--surface-2);
      display: block;
      border-radius: 4px;
    }

    .attachment-file, .attachment-pdf {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.4rem 0.6rem;
      color: var(--accent);
      text-decoration: none;
      font-size: 0.78rem;
    }

    .attachment-file:hover, .attachment-pdf:hover {
      text-decoration: underline;
    }

    .attachment-caption {
      font-size: 0.7rem;
      color: var(--muted);
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
    let src = a.url || a.data || '';
    if (src && !/^(https?:|blob:|data:|\/)/i.test(src)) {
      src = '/' + src;
    }
    if (a.kind === 'image') {
      return html`
        <div class="attachment attachment-image">
          <img src="${src}" class="attachment-image" alt="${a.name || ''}">
        </div>
      `;
    } else if (a.kind === 'audio') {
      return html`
        <r-audio-player .src=${src} .name=${a.name || ''}></r-audio-player>
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
            <r-icon name="file" size="sm"></r-icon>
            <span>${a.name || 'document.pdf'}</span>
          </a>
        `;
      }

      return html`
        <div class="attachment attachment-pdf">
          <r-icon name="file" size="sm"></r-icon>
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

