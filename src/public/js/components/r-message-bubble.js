import { LightElement, defineElement } from './base.js'

export class RMessageBubble extends LightElement {
  constructor() {
    super()
  }

  static get observedAttributes() {
    return ['type']
  }

  connectedCallback() {
    if (!this.hasAttribute('type')) {
      this.setAttribute('type', 'assistant')
    }
    this._render()
  }

  attributeChangedCallback() {
    this._render()
  }

  get type() {
    return this.getAttribute('type') || 'assistant'
  }

  set type(val) {
    this.setAttribute('type', val)
  }

  get bubbleBody() {
    return this.querySelector('.bubble-body')
  }

  get bubbleContainer() {
    return this.querySelector('.bubble')
  }

  _render() {
    const type = this.type
    this.className = `message ${type}`

    if (!this.querySelector('.bubble')) {
      const bubble = document.createElement('div')
      bubble.className = 'bubble'

      const label = document.createElement('div')
      label.className = 'message-label'
      label.textContent = type === 'user' ? 'You' : type === 'error' ? 'Error' : 'Rorschach'

      bubble.appendChild(label)
      this.appendChild(bubble)
    }
  }

  addBody() {
    const body = document.createElement('div')
    body.className = 'bubble-body'
    this.querySelector('.bubble').appendChild(body)
    return body
  }

  addImages(images) {
    const bubble = this.querySelector('.bubble')
    const imgRow = document.createElement('div')
    imgRow.className = 'message-images'
    images.forEach(a => {
      const img = document.createElement('img')
      img.src = a.data
      img.className = 'message-image'
      imgRow.appendChild(img)
    })
    bubble.appendChild(imgRow)
  }

  addAudio(audioData) {
    const bubble = this.querySelector('.bubble')
    const audioEl = document.createElement('audio')
    audioEl.src = audioData
    audioEl.controls = true
    audioEl.className = 'message-audio'
    bubble.appendChild(audioEl)
  }

  addPdfs(pdfs) {
    const bubble = this.querySelector('.bubble')
    pdfs.forEach(pdf => {
      const chip = document.createElement('div')
      chip.className = 'message-pdf-chip'
      chip.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
      const nameSpan = document.createElement('span')
      nameSpan.textContent = pdf.name
      chip.appendChild(nameSpan)
      bubble.appendChild(chip)
    })
  }

  addText(text) {
    const bubble = this.querySelector('.bubble')
    const textEl = document.createElement('span')
    textEl.textContent = text
    bubble.appendChild(textEl)
  }

  addSources(sourcesEl) {
    const bubble = this.querySelector('.bubble')
    const body = bubble.querySelector('.bubble-body')
    if (body) {
      bubble.insertBefore(sourcesEl, body)
    } else {
      bubble.appendChild(sourcesEl)
    }
  }

  addAttachments(attachmentsEl) {
    const bubble = this.querySelector('.bubble')
    const body = bubble.querySelector('.bubble-body')
    if (body) {
      bubble.insertBefore(attachmentsEl, body)
    } else {
      bubble.appendChild(attachmentsEl)
    }
  }

  addReasoningSection() {
    const bubble = this.querySelector('.bubble')
    const details = document.createElement('details')
    details.className = 'reasoning'
    const summary = document.createElement('summary')
    summary.textContent = 'Thinking...'
    const content = document.createElement('pre')
    content.className = 'reasoning-content'
    details.appendChild(summary)
    details.appendChild(content)
    bubble.appendChild(details)
    return content
  }
}

defineElement('r-message-bubble', RMessageBubble)
