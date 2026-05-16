import { escHtml } from '../utils.js'

const panel = document.getElementById('panel-chat')
const workspace = document.getElementById('plan-workspace')
const titleEl = document.getElementById('plan-workspace-title')
const bodyEl = document.getElementById('plan-workspace-body')
const closeBtn = document.getElementById('plan-workspace-close')
const resizer = document.getElementById('plan-workspace-resizer')

let currentGraph = null
let selectedTaskId = null
let isResizing = false

const WIDTH_KEY = 'rorschach.planWorkspaceWidth'
const DEFAULT_WIDTH = 460
const MIN_WIDTH = 320
const MIN_CHAT_WIDTH = 360

function maxWorkspaceWidth() {
  const panelWidth = panel?.getBoundingClientRect().width ?? window.innerWidth
  return Math.max(MIN_WIDTH, Math.min(760, panelWidth - MIN_CHAT_WIDTH))
}

function clampWidth(width) {
  return Math.max(MIN_WIDTH, Math.min(maxWorkspaceWidth(), width))
}

function savedWidth() {
  const raw = localStorage.getItem(WIDTH_KEY)
  const parsed = raw ? Number(raw) : DEFAULT_WIDTH
  return Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_WIDTH
}

function applyWidth(width) {
  const next = clampWidth(width)
  panel?.style.setProperty('--plan-workspace-width', `${next}px`)
  return next
}

function setOpen(open) {
  panel?.classList.toggle('plan-workspace-open', open)
  if (open) applyWidth(savedWidth())
}

function setTitle(text) {
  if (titleEl) titleEl.textContent = text
}

function emptyPanel(text) {
  return `<div class="plan-empty"><span>${escHtml(text)}</span></div>`
}

async function fetchJson(path) {
  const res = await fetch(new URL(path, location.href))
  if (!res.ok) throw new Error(await res.text())
  return await res.json()
}

function formatDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

function shortLabel(value, max = 18) {
  const text = String(value || '')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function renderPlanList(plans) {
  currentGraph = null
  selectedTaskId = null
  setTitle('Plans')
  if (!bodyEl) return
  if (!plans.length) {
    bodyEl.innerHTML = emptyPanel('no saved plans')
    return
  }

  const list = document.createElement('div')
  list.className = 'plan-list'
  for (const plan of plans) {
    const btn = document.createElement('button')
    btn.className = 'plan-list-item'
    btn.type = 'button'
    btn.dataset.planId = plan.id
    btn.innerHTML = `
      <span class="plan-list-goal">${escHtml(plan.goal)}</span>
      <span class="plan-list-meta">${escHtml(formatDate(plan.createdAt))} · ${plan.taskCount} task${plan.taskCount === 1 ? '' : 's'}</span>
    `
    btn.addEventListener('click', () => openPlanGraph(plan.id))
    list.appendChild(btn)
  }
  bodyEl.replaceChildren(list)
}

function taskById(id) {
  return currentGraph?.nodes.find(node => node.id === id) ?? null
}

function renderTaskDetail(task) {
  const detail = document.createElement('div')
  detail.className = 'plan-task-detail'
  if (!task) {
    detail.innerHTML = '<div class="plan-task-placeholder">Select a task to inspect details.</div>'
    return detail
  }

  const deps = task.dependencies.length
    ? task.dependencies.map(id => taskById(id)?.label || id).join(', ')
    : 'none'
  const dependents = task.dependents.length
    ? task.dependents.map(id => taskById(id)?.label || id).join(', ')
    : 'none'

  detail.innerHTML = `
    <div class="plan-task-status">status · not tracked</div>
    <h3>${escHtml(task.label)}</h3>
    <dl>
      <dt>Description</dt>
      <dd>${escHtml(task.description || 'No description')}</dd>
      <dt>Validation</dt>
      <dd>${escHtml(task.validationCriteria || 'No validation criteria')}</dd>
      <dt>Depends on</dt>
      <dd>${escHtml(deps)}</dd>
      <dt>Unlocks</dt>
      <dd>${escHtml(dependents)}</dd>
    </dl>
  `
  return detail
}

function renderGraph(graph) {
  const nextSelectedTaskId = selectedTaskId
  currentGraph = graph
  selectedTaskId = graph.nodes.some(node => node.id === nextSelectedTaskId)
    ? nextSelectedTaskId
    : graph.nodes[0]?.id ?? null
  setTitle(graph.plan.goal)
  if (!bodyEl) return

  const shell = document.createElement('div')
  shell.className = 'plan-graph-shell'
  const meta = document.createElement('div')
  meta.className = 'plan-graph-meta'
  meta.textContent = `${formatDate(graph.plan.createdAt)} · ${graph.plan.taskCount} task${graph.plan.taskCount === 1 ? '' : 's'}`
  const graphEl = document.createElement('div')
  graphEl.className = 'plan-graph'
  const detailWrap = document.createElement('div')
  detailWrap.className = 'plan-task-detail-wrap'
  shell.append(meta, graphEl, detailWrap)
  bodyEl.replaceChildren(shell)

  const updateDetail = () => {
    detailWrap.replaceChildren(renderTaskDetail(taskById(selectedTaskId)))
  }
  updateDetail()

  if (!graph.nodes.length) {
    graphEl.innerHTML = emptyPanel('plan has no tasks')
    return
  }

  const width = Math.max(graphEl.clientWidth, 320)
  const height = Math.max(graphEl.clientHeight, 260)
  const nodeById = Object.fromEntries(graph.nodes.map(node => [node.id, { ...node }]))
  const nodes = Object.values(nodeById)
  const edges = graph.edges
    .map(edge => ({ ...edge, source: nodeById[edge.source], target: nodeById[edge.target] }))
    .filter(edge => edge.source && edge.target)

  const svg = d3.select(graphEl).append('svg')
    .attr('width', '100%')
    .attr('height', '100%')

  svg.append('defs').append('marker')
    .attr('id', 'plan-arrow')
    .attr('viewBox', '0 -4 8 8')
    .attr('refX', 8)
    .attr('refY', 0)
    .attr('markerWidth', 6)
    .attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-4L8,0L0,4')
    .attr('fill', '#00c4d4')

  const g = svg.append('g')
  svg.call(d3.zoom().scaleExtent([0.25, 4]).on('zoom', ev => g.attr('transform', ev.transform)))

  const link = g.append('g').selectAll('line').data(edges).enter().append('line')
    .attr('stroke', '#1e5264')
    .attr('stroke-width', 1.4)
    .attr('marker-end', 'url(#plan-arrow)')

  const node = g.append('g').selectAll('g').data(nodes).enter().append('g')
    .attr('class', d => 'plan-node' + (d.id === selectedTaskId ? ' selected' : ''))
    .attr('cursor', 'pointer')
    .call(d3.drag()
      .on('start', (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y })
      .on('drag',  (ev, d) => { d.fx = ev.x; d.fy = ev.y })
      .on('end',   (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null })
    )
    .on('click', (_ev, d) => {
      selectedTaskId = d.id
      node.attr('class', n => 'plan-node' + (n.id === selectedTaskId ? ' selected' : ''))
      updateDetail()
    })

  node.append('rect')
    .attr('x', -62)
    .attr('y', -22)
    .attr('width', 124)
    .attr('height', 44)
    .attr('rx', 6)

  node.append('text')
    .text(d => shortLabel(d.label))
    .attr('text-anchor', 'middle')
    .attr('dy', '0.3em')
    .attr('font-size', '10px')
    .attr('font-family', 'var(--font-mono)')

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(edges).id(d => d.id).distance(135).strength(0.7))
    .force('charge', d3.forceManyBody().strength(-320))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('x', d3.forceX(width / 2).strength(0.06))
    .force('y', d3.forceY(height / 2).strength(0.08))
    .force('collide', d3.forceCollide(76))
    .on('tick', () => {
      link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => {
          const dx = d.target.x - d.source.x
          const dy = d.target.y - d.source.y
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          return d.target.x - (dx / dist) * 68
        })
        .attr('y2', d => {
          const dx = d.target.x - d.source.x
          const dy = d.target.y - d.source.y
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          return d.target.y - (dy / dist) * 28
        })
      node.attr('transform', d => `translate(${d.x},${d.y})`)
    })
}

export async function openPlanList() {
  setOpen(true)
  setTitle('Plans')
  if (bodyEl) bodyEl.innerHTML = emptyPanel('loading plans')
  try {
    renderPlanList(await fetchJson('plans'))
  } catch {
    if (bodyEl) bodyEl.innerHTML = emptyPanel('could not load plans')
  }
}

export async function openPlanGraph(planId) {
  setOpen(true)
  setTitle('Plan')
  if (bodyEl) bodyEl.innerHTML = emptyPanel('loading graph')
  try {
    renderGraph(await fetchJson(`plans/${encodeURIComponent(planId)}/graph`))
  } catch {
    if (bodyEl) bodyEl.innerHTML = emptyPanel('could not load graph')
  }
}

export function closePlanWorkspace() {
  setOpen(false)
}

closeBtn?.addEventListener('click', closePlanWorkspace)

resizer?.addEventListener('pointerdown', (event) => {
  if (!panel?.classList.contains('plan-workspace-open')) return
  isResizing = true
  resizer.setPointerCapture(event.pointerId)
  document.body.classList.add('plan-workspace-resizing')
  event.preventDefault()
})

resizer?.addEventListener('pointermove', (event) => {
  if (!isResizing || !panel) return
  const rect = panel.getBoundingClientRect()
  const width = applyWidth(rect.right - event.clientX)
  localStorage.setItem(WIDTH_KEY, String(width))
})

function finishResize(event) {
  if (!isResizing) return
  isResizing = false
  document.body.classList.remove('plan-workspace-resizing')
  if (event.pointerId !== undefined && resizer?.hasPointerCapture(event.pointerId)) {
    resizer.releasePointerCapture(event.pointerId)
  }
  if (currentGraph) renderGraph(currentGraph)
}

resizer?.addEventListener('pointerup', finishResize)
resizer?.addEventListener('pointercancel', finishResize)

window.addEventListener('resize', () => {
  if (!panel?.classList.contains('plan-workspace-open')) return
  const width = applyWidth(savedWidth())
  localStorage.setItem(WIDTH_KEY, String(width))
  if (currentGraph) renderGraph(currentGraph)
})

workspace?.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closePlanWorkspace()
})
