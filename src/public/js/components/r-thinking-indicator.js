import { LightElement } from './base.js'

export class RThinkingIndicator extends LightElement {
  constructor() {
    super()
  }

  show(toolLabel = '', extraClass = '') {
    this.className = 'tool-indicator' + (extraClass ? ' ' + extraClass : '')
    this.innerHTML = ''

    if (toolLabel) {
      const badge = document.createElement('div')
      badge.className = 'tool-badge'
      badge.textContent = toolLabel
      this.appendChild(badge)
    }

    const dotsRow = document.createElement('div')
    dotsRow.className = 'dots-row'
    for (let i = 0; i < 3; i++) {
      const d = document.createElement('div')
      d.className = 'dot'
      dotsRow.appendChild(d)
    }
    this.appendChild(dotsRow)
  }

  remove() {
    this.parentNode?.removeChild(this)
  }
}

if (!customElements.get('r-thinking-indicator')) {
  customElements.define('r-thinking-indicator', RThinkingIndicator)
}
