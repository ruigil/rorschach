import { LightElement, escHtml, tsStr, defineElement } from './base.js'

const MAX_LOGS = 500

export class RLogStream extends LightElement {
  constructor() {
    super()
    this._count = 0
  }

  get count() { return this._count }

  append(event) {
    const empty = this.querySelector('r-empty-state')
    if (empty) empty.remove()

    if (this._count >= MAX_LOGS) {
      this.querySelector('.log-entry:last-child')?.remove()
      this._count--
    }

    const level = event.level || 'info'
    const entry = document.createElement('div')
    entry.className = 'log-entry'
    const data = event.data !== undefined
      ? `<span class="log-data">${JSON.stringify(event.data)}</span>`
      : ''
    entry.innerHTML = `
      <span class="log-ts">${tsStr(event.timestamp || Date.now())}</span>
      <span class="log-level ${level}">${level.toUpperCase()}</span>
      <span class="log-body">
        <span class="log-source">[${event.source || '?'}]</span><span class="log-msg ${level}">${escHtml(event.message || '')}</span>${data}
      </span>
    `
    this.prepend(entry)
    this._count++
    return this._count
  }

  clear() {
    this.querySelectorAll('.log-entry').forEach(el => el.remove())
    this._count = 0
    if (!this.querySelector('r-empty-state')) {
      const empty = document.createElement('r-empty-state')
      empty.setAttribute('variant', 'panel')
      empty.setAttribute('name', 'terminal')
      empty.setAttribute('text', 'awaiting log events')
      this.appendChild(empty)
    }
    return 0
  }
}

defineElement('r-log-stream', RLogStream)
