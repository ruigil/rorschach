import { LightElement, escHtml, ICONS } from './base.js'

export class RActorTree extends LightElement {
  constructor() {
    super()
    this._actorsMap = {}
    this._selectedActor = null
    this._collapsedSet = new Set()
    this.addEventListener('click', (e) => this._onClick(e))
  }

  get selectedActor() { return this._selectedActor }
  get actorsMap() { return this._actorsMap }

  update(actors) {
    for (const a of actors) {
      this._actorsMap[a.name] = a
    }
    const seen = new Set(actors.map(a => a.name))
    for (const k of Object.keys(this._actorsMap)) {
      if (!seen.has(k)) delete this._actorsMap[k]
    }
    if (this._selectedActor && !this._actorsMap[this._selectedActor]) {
      this._selectedActor = null
    }
    this._render()
    return this._selectedActor ? this._actorsMap[this._selectedActor] : null
  }

  _buildTree(actors) {
    const nodes = {}
    actors.forEach(a => {
      const parts = a.name.split('/')
      parts.forEach((_, i) => {
        const path  = parts.slice(0, i + 1).join('/')
        const label = parts[i]
        if (!nodes[path]) nodes[path] = { label, path, children: [], data: null }
      })
      nodes[a.name].data = a
    })
    const roots = []
    Object.values(nodes).forEach(node => {
      const parts = node.path.split('/')
      if (parts.length === 1) {
        roots.push(node)
      } else {
        const parentPath = parts.slice(0, -1).join('/')
        nodes[parentPath] ? nodes[parentPath].children.push(node) : roots.push(node)
      }
    })
    const sort = arr => { arr.sort((a, b) => a.label.localeCompare(b.label)); arr.forEach(n => sort(n.children)); return arr }
    return sort(roots)
  }

  _renderNodes(nodes, depth) {
    return nodes.map(node => {
      const hasChildren = node.children.length > 0
      const isCollapsed = this._collapsedSet.has(node.path)
      const isSelected  = this._selectedActor === node.path
      const status      = node.data?.status || (hasChildren && !node.data ? null : 'running')
      const padLeft     = `${0.6 + depth * 1.1}rem`

      const chevron = hasChildren
        ? `<span class="tree-chevron" data-path="${node.path}">${isCollapsed ? ICONS['chevron-right'] : ICONS['chevron-down'] }</span>`
        : `<span class="tree-spacer"></span>`

      const dot = status
        ? `<span class="tree-dot ${status}"></span>`
        : `<span class="tree-dot-empty"></span>`

      const count = node.data ? `<span class="tree-msg-count">${node.data.messagesProcessed ?? 0}</span>` : ''

      const children = hasChildren && !isCollapsed
        ? `<div class="tree-children">${this._renderNodes(node.children, depth + 1)}</div>`
        : ''

      return `
        <div class="tree-node">
          <div class="tree-row${isSelected ? ' selected' : ''}" style="padding-left:${padLeft}" data-path="${node.path}" data-has-data="${!!node.data}">
            ${chevron}${dot}<span class="tree-label">${escHtml(node.label)}</span>${count}
          </div>
          ${children}
        </div>
      `
    }).join('')
  }

  _render() {
    const roots = this._buildTree(Object.values(this._actorsMap))
    this.innerHTML = roots.length ? this._renderNodes(roots, 0) : ''
  }

  _onClick(e) {
    const row = e.target.closest('.tree-row')
    if (!row) return
    const path    = row.dataset.path
    const hasData = row.dataset.hasData === 'true'

    if (e.target.closest('.tree-chevron')) {
      this._collapsedSet.has(path) ? this._collapsedSet.delete(path) : this._collapsedSet.add(path)
      this._render()
      return
    }

    if (hasData) {
      this._selectedActor = path
      this._render()
      this.dispatchEvent(new CustomEvent('actor-select', {
        bubbles: true,
        detail: { actor: this._actorsMap[path] },
      }))
    } else {
      this._collapsedSet.has(path) ? this._collapsedSet.delete(path) : this._collapsedSet.add(path)
      this._render()
    }
  }
}

if (!customElements.get('r-actor-tree')) {
  customElements.define('r-actor-tree', RActorTree)
}
