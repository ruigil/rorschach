import { RorschachElement, escHtml, defineElement } from './base.js'
import { store } from '../store.js'

const CSS = `
:host {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted, #215060);
  transition: background 0.4s, box-shadow 0.4s;
  flex-shrink: 0;
}

:host([status="connected"]) .dot {
  background: var(--accent, #00c4d4);
  box-shadow: 0 0 8px rgba(0,196,212,0.5);
  animation: signalPulse 2.5s ease-out infinite;
}

:host([status="disconnected"]) .dot {
  background: var(--error, #e06030);
  box-shadow: 0 0 6px rgba(224,96,48,0.4);
}

:host([status="running"]) .dot {
  background: var(--green, #39e8a0);
  box-shadow: 0 0 4px var(--green-glow, rgba(57, 232, 160, 0.2));
}

:host([status="stopped"]) .dot {
  background: var(--muted, #215060);
}

:host([status="error"]) .dot {
  background: var(--error, #e06030);
}

.label {
  font-size: 0.68rem;
  font-weight: 500;
  color: var(--text-dim, #3d6878);
  letter-spacing: 0.06em;
  white-space: nowrap;
}

@keyframes signalPulse {
  0%   { box-shadow: 0 0 0 0 rgba(0,196,212,0.5); }
  70%  { box-shadow: 0 0 0 6px rgba(0,196,212,0); }
  100% { box-shadow: 0 0 0 0 rgba(0,196,212,0); }
}
`

export class RStatusDot extends RorschachElement {
  static observedAttributes = ['status', 'label']

  constructor() {
    super()
    this.loadStyles(CSS)
  }

  connectedCallback() {
    this.render()
    this._unsub = store.subscribe('isConnected', (connected) => {
      this.setAttribute('status', connected ? 'connected' : 'disconnected')
      this.setAttribute('label', connected ? 'connected' : 'reconnecting…')
    })
  }

  disconnectedCallback() {
    if (this._unsub) {
      this._unsub()
      this._unsub = null
    }
  }

  attributeChangedCallback() {
    this.render()
  }

  render() {
    const label = this.getAttribute('label') || ''
    this.shadowRoot.innerHTML = `<span class="dot"></span>${label ? `<span class="label">${escHtml(label)}</span>` : ''}`
  }
}

defineElement('r-status-dot', RStatusDot)
