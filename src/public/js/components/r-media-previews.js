import { RorschachElement, escHtml } from './base.js'

const CSS = `
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
`

export class RMediaPreviews extends RorschachElement {
  constructor() {
    super()
    this._pendingImages = []
    this._pendingAudio = null
    this._pendingPdfs = []
    this.loadStyles(CSS)
  }

  getPending() {
    return {
      images: [...this._pendingImages],
      audio: this._pendingAudio,
      pdfs: [...this._pendingPdfs],
    }
  }

  clear() {
    this._pendingImages = []
    this._pendingAudio = null
    this._pendingPdfs = []
    this._render()
  }

  addImage(dataUrl) {
    this._pendingImages.push(dataUrl)
    this._render()
  }

  setAudio(dataUrl) {
    this._pendingAudio = dataUrl
    this._render()
  }

  addPdf(dataUrl, name) {
    this._pendingPdfs.push({ dataUrl, name })
    this._render()
  }

  _render() {
    const hasContent = this._pendingImages.length > 0 || this._pendingAudio !== null || this._pendingPdfs.length > 0
    this.classList.toggle('hidden', !hasContent)
    if (!hasContent) {
      this.shadowRoot.innerHTML = ''
      return
    }

    let html = ''

    this._pendingImages.forEach((dataUrl, i) => {
      html += `
        <div class="image-thumb-wrap">
          <img src="${dataUrl}" class="image-thumb">
          <button class="image-thumb-remove" data-type="image" data-index="${i}">&times;</button>
        </div>
      `
    })

    if (this._pendingAudio) {
      html += `
        <div class="audio-preview-wrap">
          <audio src="${this._pendingAudio}" controls class="audio-preview-player"></audio>
          <button class="image-thumb-remove" data-type="audio">&times;</button>
        </div>
      `
    }

    this._pendingPdfs.forEach((pdf, i) => {
      html += `
        <div class="pdf-preview-wrap">
          <span class="pdf-preview-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          </span>
          <span class="pdf-preview-name">${escHtml(pdf.name)}</span>
          <button class="image-thumb-remove pdf-remove" data-type="pdf" data-index="${i}">&times;</button>
        </div>
      `
    })

    this.shadowRoot.innerHTML = html

    this.shadowRoot.querySelectorAll('.image-thumb-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const type = e.currentTarget.dataset.type
        const index = parseInt(e.currentTarget.dataset.index, 10)

        if (type === 'image') {
          this._pendingImages.splice(index, 1)
        } else if (type === 'audio') {
          this._pendingAudio = null
        } else if (type === 'pdf') {
          this._pendingPdfs.splice(index, 1)
        }

        this._render()
        this.dispatchEvent(new CustomEvent('media-remove', { bubbles: true }))
      })
    })
  }
}

if (!customElements.get('r-media-previews')) {
  customElements.define('r-media-previews', RMediaPreviews)
}
