import { RorschachElement } from './base.js'

const CSS = `
:host {
  display: inline-flex;
  align-items: center;
  font-size: 0.62rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-align: center;
  padding: 0.1rem 0.3rem;
  border-radius: 3px;
  font-family: var(--font-mono, monospace);
  white-space: nowrap;
}
:host([level="debug"]) { color: var(--log-debug, #3d6878); }
:host([level="info"])  { color: var(--log-info, #5ba0b8); }
:host([level="warn"])  { color: var(--log-warn, #c4843a); }
:host([level="error"]) { color: var(--log-error, #e06030); }

:host([variant="actor"]) {
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 0.15rem 0.5rem;
}
:host([variant="actor"][status="running"]) { color: var(--green, #39e8a0); background: rgba(69, 196, 154, 0.1); }
:host([variant="actor"][status="stopped"]) { color: var(--text-dim, #3d6878); background: rgba(255,255,255,0.04); }
:host([variant="actor"][status="error"])   { color: var(--error, #e06030); background: rgba(201, 95, 82, 0.1); }
`

export class RBadge extends RorschachElement {
  static observedAttributes = ['level', 'variant', 'status']

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
    this.shadowRoot.textContent = this.textContent
  }
}

if (!customElements.get('r-badge')) {
  customElements.define('r-badge', RBadge)
}
