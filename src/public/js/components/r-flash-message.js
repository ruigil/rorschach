import { RorschachElement, defineElement } from './base.js'

const CSS = `
:host {
  display: contents;
}

.msg {
  font-size: 0.68rem;
  font-family: var(--font-mono, monospace);
  font-weight: 300;
  opacity: 0;
  transition: opacity 0.3s;
  margin-left: auto;
  white-space: nowrap;
}

.msg.visible { opacity: 1; }
.msg.save    { color: var(--green, #39e8a0); }
.msg.error   { color: var(--error, #e06030); }
`

export class RFlashMessage extends RorschachElement {
  constructor() {
    super()
    this.loadStyles(CSS)
    this._timer = null
  }

  connectedCallback() {
    this.shadowRoot.innerHTML = `<span class="msg"></span>`
  }

  show(type, message, duration = 2200) {
    clearTimeout(this._timer)
    const el = this.$('.msg')
    if (!el) return
    el.className = `msg ${type} visible`
    el.textContent = message
    this._timer = setTimeout(() => el.classList.remove('visible'), duration)
  }

  save(duration = 2200) {
    this.show('save', 'saved', duration)
  }

  error(message, duration = 4000) {
    this.show('error', message, duration)
  }
}

defineElement('r-flash-message', RFlashMessage)
