import { LightElement } from './base.js'

export class RMediaPreviews extends LightElement {
  constructor() {
    super()
    this._pendingImages = []
    this._pendingAudio = null
    this._pendingPdfs = []
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
      this.innerHTML = ''
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
          <span class="pdf-preview-name">${pdf.name}</span>
          <button class="image-thumb-remove pdf-remove" data-type="pdf" data-index="${i}">&times;</button>
        </div>
      `
    })

    this.innerHTML = html

    this.querySelectorAll('.image-thumb-remove').forEach(btn => {
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
