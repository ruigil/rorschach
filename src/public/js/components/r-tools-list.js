import { LightElement, escHtml, defineElement } from './base.js'

export class RToolsList extends LightElement {
  constructor() {
    super()
    this._toolsMap = {}
  }

  register(name, schema) {
    this._toolsMap[name] = schema
    this._render()
  }

  unregister(name) {
    delete this._toolsMap[name]
    this._render()
  }

  _render() {
    const names = Object.keys(this._toolsMap).sort()
    this.querySelectorAll('.tool-row').forEach(el => el.remove())
    const emptyEl = this.querySelector('r-empty-state')
    if (names.length === 0) {
      if (emptyEl) emptyEl.style.display = ''
      return
    }
    if (emptyEl) emptyEl.style.display = 'none'
    for (const name of names) {
      const desc = this._toolsMap[name]?.function?.description ?? ''
      const row  = document.createElement('div')
      row.className = 'tool-row'
      row.innerHTML = `<span class="tool-name">${escHtml(name)}</span><span class="tool-desc">${escHtml(desc)}</span>`
      this.appendChild(row)
    }
  }
}

defineElement('r-tools-list', RToolsList)
