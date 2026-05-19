import { RorschachElement, defineElement } from './base.js'

const CSS = `
:host {
  display: flex;
  align-items: stretch;
}

::slotted(button) {
  font-size: 0.64rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-dim, #3d6878);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 0 1rem;
  cursor: pointer;
  font-family: var(--font-ui, sans-serif);
  transition: color 0.15s, border-color 0.15s;
  position: relative;
  top: 1px;
}

::slotted(button:hover) {
  color: var(--text-mid, #8abccc);
}

::slotted(button.active) {
  color: var(--accent, #00c4d4);
  border-bottom-color: var(--accent, #00c4d4);
}
`

export class RTabs extends RorschachElement {
  constructor() {
    super()
    this.loadStyles(CSS)
  }

  connectedCallback() {
    this.shadowRoot.innerHTML = '<slot></slot>'
    this.shadowRoot.addEventListener('click', (e) => {
      const btn = e.target.closest('button')
      if (!btn) return
      const tabId = btn.dataset.tab || btn.dataset.subtab || btn.dataset.configTab
      if (!tabId) return

      const allBtns = this.querySelectorAll('button')
      allBtns.forEach(b => b.classList.remove('active'))
      btn.classList.add('active')

      this.dispatchEvent(new CustomEvent('tab-change', {
        bubbles: true,
        composed: true,
        detail: { tab: tabId },
      }))
    })
  }
}

defineElement('r-tabs', RTabs)
