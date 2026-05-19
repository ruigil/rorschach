import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { RorschachBase } from './base.js';

interface PdfPreview {
  dataUrl: string;
  name: string;
}

@customElement('r-media-previews')
export class RMediaPreviews extends RorschachBase {
  @state() private images: string[] = [];
  @state() private audio: string | null = null;
  @state() private pdfs: PdfPreview[] = [];

  static override styles = css`
    :host {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 0.65rem;
    }

    :host(.hidden) {
      display: none;
    }

    .image-thumb-wrap {
      position: relative;
      display: inline-flex;
    }

    .image-thumb {
      width: 60px;
      height: 60px;
      object-fit: cover;
      border-radius: calc(var(--radius, 8px) - 2px);
      border: 1px solid var(--border-mid);
    }

    .image-thumb-remove {
      position: absolute;
      top: -6px; right: -6px;
      width: 16px; height: 16px;
      border-radius: 50%;
      background: var(--surface-2);
      border: 1px solid var(--border-mid);
      color: var(--muted);
      font-size: 0.7rem;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }

    .image-thumb-remove:hover { color: var(--text); }

    .audio-preview-wrap {
      position: relative;
      display: inline-flex;
      align-items: center;
      height: 60px;
    }

    .audio-preview-player {
      height: 32px;
      width: 220px;
      accent-color: var(--accent);
      border-radius: calc(var(--radius, 8px) - 2px);
      outline: none;
    }

    .pdf-preview-wrap {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      height: 36px;
      padding: 0 0.6rem;
      background: var(--surface-2);
      border: 1px solid var(--border-mid);
      border-radius: var(--radius, 8px);
      color: var(--muted);
      font-size: 0.72rem;
      max-width: 200px;
    }

    .pdf-preview-icon {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      color: var(--accent);
    }

    .pdf-preview-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .pdf-remove {
      margin-left: 0.25rem;
      flex-shrink: 0;
    }
  `;

  override render() {
    const hasContent = this.images.length > 0 || this.audio !== null || this.pdfs.length > 0;
    this.classList.toggle('hidden', !hasContent);
    if (!hasContent) return html``;

    return html`
      ${this.images.map((dataUrl, i) => html`
        <div class="image-thumb-wrap">
          <img src="${dataUrl}" class="image-thumb">
          <button class="image-thumb-remove" @click=${() => this.removeMedia('image', i)}>&times;</button>
        </div>
      `)}

      ${this.audio ? html`
        <div class="audio-preview-wrap">
          <audio src="${this.audio}" controls class="audio-preview-player"></audio>
          <button class="image-thumb-remove" @click=${() => this.removeMedia('audio')}>&times;</button>
        </div>
      ` : ''}

      ${this.pdfs.map((pdf, i) => html`
        <div class="pdf-preview-wrap">
          <span class="pdf-preview-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          </span>
          <span class="pdf-preview-name">${pdf.name}</span>
          <button class="image-thumb-remove pdf-remove" @click=${() => this.removeMedia('pdf', i)}>&times;</button>
        </div>
      `)}
    `;
  }

  getPending() {
    return {
      images: [...this.images],
      audio: this.audio,
      pdfs: [...this.pdfs],
    };
  }

  clear() {
    this.images = [];
    this.audio = null;
    this.pdfs = [];
  }

  addImage(dataUrl: string) {
    this.images = [...this.images, dataUrl];
  }

  setAudio(dataUrl: string | null) {
    this.audio = dataUrl;
  }

  addPdf(dataUrl: string, name: string) {
    this.pdfs = [...this.pdfs, { dataUrl, name }];
  }

  private removeMedia(type: 'image' | 'audio' | 'pdf', index?: number) {
    if (type === 'image' && index !== undefined) {
      this.images = this.images.filter((_, i) => i !== index);
    } else if (type === 'audio') {
      this.audio = null;
    } else if (type === 'pdf' && index !== undefined) {
      this.pdfs = this.pdfs.filter((_, i) => i !== index);
    }
    
    this.dispatchEvent(new CustomEvent('media-remove', { bubbles: true, composed: true }));
  }
}
