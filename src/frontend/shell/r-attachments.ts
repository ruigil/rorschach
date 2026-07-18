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

@customElement('r-audio-player')
export class RAudioPlayer extends RorschachBase {
  @property({ type: String }) src = '';
  @property({ type: String }) name = '';

  @state() private isPlaying = false;
  @state() private currentTime = 0;
  @state() private duration = 0;

  private audio = new Audio();

  override connectedCallback() {
    super.connectedCallback();
    this.audio.src = this.src;
    this.audio.addEventListener('play', this.onPlay);
    this.audio.addEventListener('pause', this.onPause);
    this.audio.addEventListener('timeupdate', this.onTimeUpdate);
    this.audio.addEventListener('loadedmetadata', this.onLoadedMetadata);
    this.audio.addEventListener('durationchange', this.onDurationChange);
    this.audio.addEventListener('ended', this.onEnded);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.audio.pause();
    this.audio.removeEventListener('play', this.onPlay);
    this.audio.removeEventListener('pause', this.onPause);
    this.audio.removeEventListener('timeupdate', this.onTimeUpdate);
    this.audio.removeEventListener('loadedmetadata', this.onLoadedMetadata);
    this.audio.removeEventListener('durationchange', this.onDurationChange);
    this.audio.removeEventListener('ended', this.onEnded);
  }

  override willUpdate(changedProperties: Map<string | symbol, unknown>) {
    if (changedProperties.has('src') && this.src) {
      this.audio.src = this.src;
      this.audio.load();
      this.currentTime = 0;
      this.isPlaying = false;
      this.duration = 0;
    }
  }

  private onPlay = () => { this.isPlaying = true; };
  private onPause = () => { this.isPlaying = false; };
  private onEnded = () => {
    this.isPlaying = false;
    this.currentTime = 0;
  };
  private onTimeUpdate = () => {
    this.currentTime = this.audio.currentTime;
    if (isFinite(this.audio.duration) && !isNaN(this.audio.duration) && this.audio.duration !== this.duration) {
      this.duration = this.audio.duration;
    }
  };
  private onDurationChange = () => {
    const d = this.audio.duration;
    if (isFinite(d) && !isNaN(d)) {
      this.duration = d;
    }
  };
  private onLoadedMetadata = () => {
    const d = this.audio.duration;
    if (d === Infinity) {
      this.audio.currentTime = 1e9;
      const tempTimeUpdate = () => {
        this.duration = this.audio.duration;
        this.audio.currentTime = 0;
      };
      this.audio.addEventListener('timeupdate', tempTimeUpdate, { once: true });
    } else if (isFinite(d) && !isNaN(d)) {
      this.duration = d;
    }
  };

  private togglePlay() {
    if (this.isPlaying) {
      this.audio.pause();
    } else {
      this.audio.play().catch(err => console.error("Audio playback error:", err));
    }
  }

  private onSeek(e: Event) {
    const target = e.target as HTMLInputElement;
    const value = parseFloat(target.value);
    this.audio.currentTime = value;
    this.currentTime = value;
  }

  private formatTime(secs: number): string {
    if (isNaN(secs) || !isFinite(secs)) return '0:00';
    const minutes = Math.floor(secs / 60);
    const seconds = Math.floor(secs % 60);
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  }

  static override styles = css`
    :host {
      display: block;
      width: 100%;
      max-width: 100%;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius, 8px);
      padding: 0.5rem 0.75rem;
      box-sizing: border-box;
      font-family: var(--font-mono, monospace);
    }

    .player-container {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      width: 100%;
    }

    .play-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: none;
      background: var(--accent);
      color: var(--bg);
      cursor: pointer;
      flex-shrink: 0;
      transition: background 0.15s ease, transform 0.1s ease;
    }

    .play-btn:hover {
      background: var(--accent-bright);
      transform: scale(1.05);
    }

    .play-btn:active {
      transform: scale(0.95);
    }

    .play-btn svg {
      width: 12px;
      height: 12px;
      fill: currentColor;
    }

    .timeline-container {
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      min-width: 0;
    }

    .audio-title {
      font-size: 0.7rem;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .controls-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .slider {
      flex-grow: 1;
      -webkit-appearance: none;
      appearance: none;
      height: 4px;
      border-radius: 2px;
      background: linear-gradient(to right, var(--accent) 0%, var(--accent) var(--seek-percent, 0%), var(--border-mid) var(--seek-percent, 0%), var(--border-mid) 100%);
      outline: none;
      cursor: pointer;
    }

    .slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--accent);
      transition: background 0.15s ease, transform 0.1s ease;
    }

    .slider::-webkit-slider-thumb:hover {
      background: var(--accent-bright);
      transform: scale(1.2);
    }

    .slider::-moz-range-thumb {
      width: 10px;
      height: 10px;
      border: none;
      border-radius: 50%;
      background: var(--accent);
      transition: background 0.15s ease, transform 0.1s ease;
      cursor: pointer;
    }

    .slider::-moz-range-thumb:hover {
      background: var(--accent-bright);
      transform: scale(1.2);
    }

    .time-display {
      font-size: 0.65rem;
      color: var(--text-dim);
      flex-shrink: 0;
      user-select: none;
    }
  `;

  override render() {
    const percent = this.duration ? (this.currentTime / this.duration) * 100 : 0;
    return html`
      <div class="player-container">
        <button class="play-btn" @click=${this.togglePlay} aria-label=${this.isPlaying ? 'Pause' : 'Play'}>
          ${this.isPlaying 
            ? html`<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`
            : html`<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`
          }
        </button>
        <div class="timeline-container">
          ${this.name ? html`<div class="audio-title" title="${this.name}">${this.name}</div>` : html`<div class="audio-title">Audio attachment</div>`}
          <div class="controls-row">
            <input 
              type="range" 
              class="slider" 
              step="any"
              .value=${String(this.currentTime)} 
              min="0" 
              .max=${String(this.duration || 100)} 
              @input=${this.onSeek}
              style="--seek-percent: ${percent}%"
            />
            <span class="time-display">
              ${this.formatTime(this.currentTime)} / ${this.formatTime(this.duration)}
            </span>
          </div>
        </div>
      </div>
    `;
  }
}
