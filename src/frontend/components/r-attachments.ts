import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase, escHtml } from './base.js';

export interface Attachment {
  kind: 'image' | 'audio' | 'video' | 'file';
  url: string;
  alt?: string;
}

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
    if (a.kind === 'image') {
      return html`
        <div class="attachment attachment-image">
          <img src="${a.url}" class="attachment-image" ?alt="${a.alt}" .alt="${a.alt || ''}">
        </div>
      `;
    } else if (a.kind === 'audio') {
      return html`
        <div class="attachment attachment-audio">
          <audio src="${a.url}" controls class="attachment-audio"></audio>
          ${a.alt ? html`<div class="attachment-caption">${a.alt}</div>` : ''}
        </div>
      `;
    } else if (a.kind === 'video') {
      return html`
        <div class="attachment attachment-video">
          <video src="${a.url}" controls class="attachment-video"></video>
          ${a.alt ? html`<div class="attachment-caption">${a.alt}</div>` : ''}
        </div>
      `;
    } else {
      return html`
        <div class="attachment attachment-file">
          <a href="${a.url}" target="_blank" rel="noopener noreferrer" class="attachment-file">
            ${a.alt || a.url.split('/').pop() || 'file'}
          </a>
        </div>
      `;
    }
  }

  /**
   * Backward compatibility
   */
  renderLegacy(attachments: Attachment[]) {
    this.items = attachments;
  }
}
