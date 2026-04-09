import { escHtml, CHEVRON_DOWN, CHEVRON_RIGHT } from '../utils.js'
import { updateTopics } from './topics.js'

const actorTreeEl    = document.getElementById('actor-tree')
const metricsEmpty   = document.getElementById('metrics-empty')
const metricsSummary = document.getElementById('metrics-summary')
const sumActors      = document.getElementById('sum-actors')
const sumRecv        = document.getElementById('sum-recv')
const sumDone        = document.getElementById('sum-done')
const sumFail        = document.getElementById('sum-fail')
const actorDetailEl  = document.getElementById('actor-detail')

export const actorsMap = {}
let selectedActor = null
const collapsedSet = new Set()

function buildActorTree(actors) {
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

function renderTreeNodes(nodes, depth) {
  return nodes.map(node => {
    const hasChildren = node.children.length > 0
    const isCollapsed = collapsedSet.has(node.path)
    const isSelected  = selectedActor === node.path
    const status      = node.data?.status || (hasChildren && !node.data ? null : 'running')
    const padLeft     = `${0.6 + depth * 1.1}rem`

    const chevron = hasChildren
      ? `<span class="tree-chevron" data-path="${node.path}">${isCollapsed ? CHEVRON_RIGHT : CHEVRON_DOWN}</span>`
      : `<span class="tree-spacer"></span>`

    const dot = status
      ? `<span class="tree-dot ${status}"></span>`
      : `<span class="tree-dot-empty"></span>`

    const count = node.data ? `<span class="tree-msg-count">${node.data.messagesProcessed ?? 0}</span>` : ''

    const children = hasChildren && !isCollapsed
      ? `<div class="tree-children">${renderTreeNodes(node.children, depth + 1)}</div>`
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

function rerenderTree() {
  const roots = buildActorTree(Object.values(actorsMap))
  actorTreeEl.innerHTML = roots.length ? renderTreeNodes(roots, 0) : ''
}

actorTreeEl.addEventListener('click', e => {
  const row = e.target.closest('.tree-row')
  if (!row) return
  const path    = row.dataset.path
  const hasData = row.dataset.hasData === 'true'

  if (e.target.closest('.tree-chevron')) {
    collapsedSet.has(path) ? collapsedSet.delete(path) : collapsedSet.add(path)
    rerenderTree()
    return
  }

  if (hasData) {
    selectedActor = path
    rerenderTree()
    renderActorDetail(actorsMap[path])
  } else {
    collapsedSet.has(path) ? collapsedSet.delete(path) : collapsedSet.add(path)
    rerenderTree()
  }
})

function renderActorDetail(actor) {
  if (!actor) {
    actorDetailEl.innerHTML = `
      <div class="empty-panel">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
        </svg>
        <span>select an actor to inspect</span>
      </div>`
    return
  }

  const status = actor.status || 'running'
  const failed = actor.messagesFailed ?? 0
  const avg    = typeof actor.processingTime?.avg === 'number' ? actor.processingTime.avg.toFixed(2) : '—'
  const min    = typeof actor.processingTime?.min === 'number' ? actor.processingTime.min.toFixed(2) : '—'
  const max    = typeof actor.processingTime?.max === 'number' ? actor.processingTime.max.toFixed(2) : '—'

  const parts = actor.name.split('/')
  const breadcrumb = parts.map((p, i) =>
    i < parts.length - 1
      ? `<span class="crumb">${escHtml(p)}</span><span class="crumb-sep">/</span>`
      : `<span class="crumb active">${escHtml(p)}</span>`
  ).join('')

  const stateSection = actor.state !== undefined && actor.state !== null
    ? `<div class="detail-section-label">state</div>
       <pre class="detail-state">${escHtml(JSON.stringify(actor.state, null, 2))}</pre>`
    : ''

  actorDetailEl.innerHTML = `
    <div class="detail-head">
      <div class="detail-path">${breadcrumb}</div>
      <span class="actor-status ${status}">${status}</span>
    </div>
    <div class="detail-divider"></div>
    <div class="detail-section-label">messages</div>
    <div class="detail-grid">
      <div class="detail-stat">
        <span class="ds-val">${actor.messagesReceived ?? 0}</span>
        <span class="ds-key">received</span>
      </div>
      <div class="detail-stat">
        <span class="ds-val">${actor.messagesProcessed ?? 0}</span>
        <span class="ds-key">processed</span>
      </div>
      <div class="detail-stat${failed > 0 ? ' error' : ''}">
        <span class="ds-val${failed > 0 ? ' error' : ''}">${failed}</span>
        <span class="ds-key">failed</span>
      </div>
      <div class="detail-stat">
        <span class="ds-val">${actor.mailboxSize ?? 0}</span>
        <span class="ds-key">mailbox</span>
      </div>
    </div>
    <div class="detail-section-label">processing time</div>
    <div class="detail-grid three">
      <div class="detail-stat">
        <span class="ds-val sm">${avg} <span class="ds-unit">ms</span></span>
        <span class="ds-key">average</span>
      </div>
      <div class="detail-stat">
        <span class="ds-val sm">${min} <span class="ds-unit">ms</span></span>
        <span class="ds-key">minimum</span>
      </div>
      <div class="detail-stat">
        <span class="ds-val sm">${max} <span class="ds-unit">ms</span></span>
        <span class="ds-key">maximum</span>
      </div>
    </div>
    ${stateSection}
  `
}

export function updateMetrics(event) {
  if (metricsEmpty?.parentNode) metricsEmpty.remove()

  const actors = event.actors || []
  let totRecv = 0, totDone = 0, totFail = 0
  actors.forEach(a => {
    totRecv += a.messagesReceived  || 0
    totDone += a.messagesProcessed || 0
    totFail += a.messagesFailed    || 0
    actorsMap[a.name] = a
  })

  const seen = new Set(actors.map(a => a.name))
  Object.keys(actorsMap).forEach(k => { if (!seen.has(k)) delete actorsMap[k] })
  if (selectedActor && !actorsMap[selectedActor]) selectedActor = null

  if (actors.length > 0) {
    const isMetricsActive = !!document.querySelector('.obs-subtab[data-subtab="metrics"].active')
    metricsSummary.style.display = isMetricsActive ? 'flex' : 'none'
    sumActors.textContent = actors.length
    sumRecv.textContent   = totRecv
    sumDone.textContent   = totDone
    sumFail.textContent   = totFail
  }

  rerenderTree()
  if (selectedActor && actorsMap[selectedActor]) {
    renderActorDetail(actorsMap[selectedActor])
  }

  if (event.topics) updateTopics(event.topics)
}
