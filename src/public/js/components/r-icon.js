import { RorschachElement, ICONS, defineElement } from './base.js'

const CSS = `
:host {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: inherit;
  line-height: 0;
}
:host([size="sm"]) { width: 10px; height: 10px; }
:host([size="md"]) { width: 15px; height: 15px; }
:host([size="lg"]) { width: 28px; height: 28px; }
:host([size="xl"]) { width: 48px; height: 48px; }
:host(:not([size])) { width: 15px; height: 15px; }
svg { width: 100%; height: 100%; }
`

export class RIcon extends RorschachElement {
  static observedAttributes = ['name', 'size']

  constructor() {
    super()
    this.loadStyles(CSS)
  }

  connectedCallback() {
    this.render()
  }

  attributeChangedCallback() {
    this.render()
  }

  render() {
    const name = this.getAttribute('name') || ''
    this.shadowRoot.innerHTML = ICONS[name] || ''
  }
}

defineElement('r-icon', RIcon)
