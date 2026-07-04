import {
  css,
  customElement,
  html,
  property,
  RorschachBase
} from './base.js';

export type MediaItem =
  | { kind: 'image'; data: string }
  | { kind: 'audio'; data: string }
  | { kind: 'pdf'; data: string; name: string };

@customElement('r-media-previews')
export class RMediaPreviews extends RorschachBase {
  @property({ type: Array }) items: MediaItem[] = [];

  static override styles = css`
    :host {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 0.85rem;
    }
    :host([hidden]) {
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
      border-radius: calc(var(--radius) - 2px);
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
      border-radius: calc(var(--radius) - 2px);
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
      border-radius: var(--radius);
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

  private _remove(index: number) {
    this.dispatchEvent(new CustomEvent('media-remove', {
      bubbles: true,
      composed: true,
      detail: { index },
    }));
  }

  override render() {
    if (this.items.length === 0) return html``;
    this.hidden = false;

    return html`
      ${this.items.map((item, i) => {
        if (item.kind === 'image') {
          return html`
            <div class="image-thumb-wrap">
              <img src="${item.data}" class="image-thumb">
              <button class="image-thumb-remove" @click=${() => this._remove(i)}>&times;</button>
            </div>
          `;
        }
        if (item.kind === 'audio') {
          return html`
            <div class="audio-preview-wrap">
              <audio src="${item.data}" controls class="audio-preview-player"></audio>
              <button class="image-thumb-remove" @click=${() => this._remove(i)}>&times;</button>
            </div>
          `;
        }
        return html`
          <div class="pdf-preview-wrap">
            <span class="pdf-preview-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </span>
            <span class="pdf-preview-name">${item.name}</span>
            <button class="image-thumb-remove pdf-remove" @click=${() => this._remove(i)}>&times;</button>
          </div>
        `;
      })}
    `;
  }
}
