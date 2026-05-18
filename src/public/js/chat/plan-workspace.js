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
  const graphEl = document.createElement('r-force-graph')
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

  graphEl.renderPlanGraph(graph, selectedTaskId, (id) => {
    selectedTaskId = id
    updateDetail()
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
