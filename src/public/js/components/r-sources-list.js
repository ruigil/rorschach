import { RorschachElement, escHtml, defineElement } from './base.js'

const CSS = `
:host {
  display: block;
}

.sources {
  margin-bottom: 0.5rem;
}

.sources-toggle {
  background: none;
  border: none;
  color: var(--muted, #8a8a8a);
  cursor: pointer;
  font-size: 0.75rem;
  padding: 0.25rem 0;
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.sources-toggle:hover {
  color: var(--fg, #e0e0e0);
}

.sources-toggle::before {
  content: '▸';
  display: inline-block;
  transition: transform 0.15s;
}

.sources-toggle.open::before {
  transform: rotate(90deg);
}

.sources-list {
  display: none;
  flex-direction: column;
  gap: 0.25rem;
  margin-top: 0.25rem;
}

.sources-list.open {
  display: flex;
}

.source-item {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.35rem 0.5rem;
  border-radius: 4px;
  text-decoration: none;
  color: inherit;
  background: var(--bg-secondary, rgba(255,255,255,0.03));
  transition: background 0.15s;
}

.source-item:hover {
  background: var(--bg-hover, rgba(255,255,255,0.06));
}

.source-title {
  font-size: 0.78rem;
  color: var(--accent, #7aa2f7);
}

.source-snippet {
  font-size: 0.7rem;
  color: var(--muted, #8a8a8a);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`

export class RSourcesList extends RorschachElement {
  constructor() {
    super()
    this.loadStyles(CSS)
  }

  render(sources) {
    if (!sources || sources.length === 0) {
      this.shadowRoot.innerHTML = ''
      return
    }

    const count = sources.length
    const label = `${count} source${count !== 1 ? 's' : ''}`

    this.shadowRoot.innerHTML = `
      <div class="sources">
        <button class="sources-toggle">${label}</button>
        <div class="sources-list">
          ${sources.map(s => `
            <a class="source-item" href="${escHtml(s.url)}" target="_blank" rel="noopener noreferrer">
              <span class="source-title">${escHtml(s.title)}</span>
              ${s.snippet ? `<span class="source-snippet">${escHtml(s.snippet)}</span>` : ''}
            </a>
          `).join('')}
        </div>
      </div>
    `

    const toggle = this.$('.sources-toggle')
    const list = this.$('.sources-list')
    toggle.addEventListener('click', () => {
      const open = list.classList.toggle('open')
      toggle.classList.toggle('open', open)
    })
  }
}

defineElement('r-sources-list', RSourcesList)
