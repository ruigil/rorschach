import { escHtml } from '../utils.js'

const toolsListEl  = document.getElementById('tools-list')
const toolsEmptyEl = document.getElementById('tools-empty')

const toolsMap = {}

export function onToolRegistered(msg) {
  toolsMap[msg.name] = msg.schema
  renderTools()
}

export function onToolUnregistered(msg) {
  delete toolsMap[msg.name]
  renderTools()
}

function renderTools() {
  const names = Object.keys(toolsMap).sort()
  toolsListEl.querySelectorAll('.tool-row').forEach(el => el.remove())
  if (names.length === 0) {
    toolsEmptyEl.style.display = ''
    return
  }
  toolsEmptyEl.style.display = 'none'
  for (const name of names) {
    const desc = toolsMap[name]?.function?.description ?? ''
    const row  = document.createElement('div')
    row.className = 'tool-row'
    row.innerHTML = `<span class="tool-name">${escHtml(name)}</span><span class="tool-desc">${escHtml(desc)}</span>`
    toolsListEl.appendChild(row)
  }
}
