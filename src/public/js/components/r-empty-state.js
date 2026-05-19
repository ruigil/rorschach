import { RorschachElement, ICONS, escHtml, defineElement } from './base.js'

const CSS = `
:host {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  pointer-events: none;
  user-select: none;
  padding: 2rem;
}

.icon {
  color: var(--accent, #00c4d4);
  opacity: 0.35;
  line-height: 0;
}

:host([variant="panel"]) .icon { opacity: 0.1; }

.text {
  font-size: 0.65rem;
  font-family: var(--font-mono, monospace);
  font-weight: 300;
  color: var(--text-dim, #3d6878);
}

.text::after {
  content: '_';
  animation: blink 1.1s step-end infinite;
}

:host([variant="chat"]) {
  animation: emptyFade 0.6s ease both;
}

:host([variant="chat"]) .text {
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  font-family: var(--font-ui, sans-serif);
}

@keyframes emptyFade {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}

.subtext {
  font-size: 0.68rem;
  color: var(--text-dim, #3d6878);
  opacity: 0.5;
  font-family: var(--font-mono, monospace);
  font-weight: 300;
}

.subtext::after {
  content: '_';
  animation: blink 1.1s step-end infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0; }
}
`

export class REmptyState extends RorschachElement {
  static observedAttributes = ['name', 'icon', 'text', 'subtext', 'variant']

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
    const name    = this.getAttribute('name') || ''
    const icon    = name ? (ICONS[name] || '') : (this.getAttribute('icon') || '')
    const text    = this.getAttribute('text') || ''
    const subtext = this.getAttribute('subtext') || ''

    let html = ''
    if (icon) html += `<span class="icon">${icon}</span>`
    if (text) html += `<span class="text">${escHtml(text)}</span>`
    if (subtext) html += `<span class="subtext">${escHtml(subtext)}</span>`
    this.shadowRoot.innerHTML = html
  }
}

defineElement('r-empty-state', REmptyState)
