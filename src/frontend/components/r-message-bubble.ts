import { html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase } from './base.js';

@customElement('r-message-bubble')
export class RMessageBubble extends RorschachBase {
  @property({ type: String, reflect: true }) type: 'assistant' | 'user' | 'error' = 'assistant';

  // Render to light DOM to reuse chat.css styles
  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.classList.add('message', this.type);
    this._ensureStructure();
  }

  override updated(changedProperties: Map<string, any>) {
    if (changedProperties.has('type')) {
      this.classList.remove('assistant', 'user', 'error');
      this.classList.add(this.type);
      const labelEl = this.querySelector('.message-label');
      if (labelEl) {
        labelEl.textContent = this._getLabelText();
      }
    }
  }

  private _getLabelText() {
    return this.type === 'user' ? 'You' : this.type === 'error' ? 'Error' : 'Rorschach';
  }

  private _ensureStructure() {
    if (!this.querySelector('.bubble')) {
      const labelText = this._getLabelText();
      this.innerHTML = `<div class="message-label">${labelText}</div><div class="bubble"></div>`;
    }
  }

  get bubbleContainer(): HTMLElement | null {
    this._ensureStructure();
    return this.querySelector('.bubble');
  }

  override render() {
    // We handle the main structure in _ensureStructure to support imperative streaming
    // and avoid Lit overwriting manually appended children.
    return html``;
  }

  addBody() {
    const body = document.createElement('div');
    body.className = 'bubble-body';
    this.bubbleContainer?.appendChild(body);
    return body;
  }

  addImages(images: { data: string }[]) {
    const bubble = this.bubbleContainer;
    if (!bubble) return;
    const imgRow = document.createElement('div');
    imgRow.className = 'message-images';
    images.forEach(a => {
      const img = document.createElement('img');
      img.src = a.data;
      img.className = 'message-image';
      imgRow.appendChild(img);
    });
    bubble.appendChild(imgRow);
  }

  addAudio(audioData: string) {
    const bubble = this.bubbleContainer;
    if (!bubble) return;
    const audioEl = document.createElement('audio');
    audioEl.src = audioData;
    audioEl.controls = true;
    audioEl.className = 'message-audio';
    bubble.appendChild(audioEl);
  }

  addPdfs(pdfs: { name: string, data?: string }[]) {
    const bubble = this.bubbleContainer;
    if (!bubble) return;
    pdfs.forEach(pdf => {
      const chip = document.createElement('div');
      chip.className = 'message-pdf-chip';
      chip.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = pdf.name;
      chip.appendChild(nameSpan);
      bubble.appendChild(chip);
    });
  }

  addText(text: string) {
    const bubble = this.bubbleContainer;
    if (!bubble) return;
    const textEl = document.createElement('span');
    textEl.textContent = text;
    bubble.appendChild(textEl);
  }

  addSources(sourcesEl: HTMLElement) {
    const bubble = this.bubbleContainer;
    if (!bubble) return;
    const body = bubble.querySelector('.bubble-body');
    if (body) {
      bubble.insertBefore(sourcesEl, body);
    } else {
      bubble.appendChild(sourcesEl);
    }
  }

  addAttachments(attachmentsEl: HTMLElement) {
    const bubble = this.bubbleContainer;
    if (!bubble) return;
    const body = bubble.querySelector('.bubble-body');
    if (body) {
      bubble.insertBefore(attachmentsEl, body);
    } else {
      bubble.appendChild(attachmentsEl);
    }
  }

  addReasoningSection() {
    const bubble = this.bubbleContainer;
    if (!bubble) return null;
    const details = document.createElement('details');
    details.className = 'reasoning';
    const summary = document.createElement('summary');
    summary.textContent = 'Thinking...';
    const content = document.createElement('pre');
    content.className = 'reasoning-content';
    details.appendChild(summary);
    details.appendChild(content);
    bubble.appendChild(details);
    return content;
  }
}
