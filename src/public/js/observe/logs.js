import { tsStr, escHtml } from '../utils.js'

const logStream  = document.getElementById('log-stream')
const logEmpty   = document.getElementById('log-empty')
const logCountEl = document.getElementById('log-count')
const clearBtn   = document.getElementById('clear-logs')

let logCount   = 0
const MAX_LOGS = 500

export function appendLog(event) {
  if (logEmpty?.parentNode) logEmpty.remove()

  if (logCount >= MAX_LOGS) {
    logStream.querySelector('.log-entry:last-child')?.remove()
    logCount--
  }

  const level = event.level || 'info'
  const entry = document.createElement('div')
  entry.className = 'log-entry'
  const data = event.data !== undefined
    ? `<span class="log-data">${JSON.stringify(event.data)}</span>`
    : ''
  entry.innerHTML = `
    <span class="log-ts">${tsStr(event.timestamp || Date.now())}</span>
    <span class="log-level ${level}">${level.toUpperCase()}</span>
    <span class="log-body">
      <span class="log-source">[${event.source || '?'}]</span><span class="log-msg ${level}">${escHtml(event.message || '')}</span>${data}
    </span>
  `
  logStream.prepend(entry)
  logCount++
  logCountEl.textContent = `${logCount} event${logCount !== 1 ? 's' : ''}`
}

clearBtn.addEventListener('click', () => {
  logStream.querySelectorAll('.log-entry').forEach(el => el.remove())
  logCount = 0
  logCountEl.textContent = '0 events'
  if (!logStream.querySelector('.empty-panel')) {
    const empty = document.createElement('div')
    empty.className = 'empty-panel'
    empty.innerHTML = `
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
        <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
      </svg>
      <span>awaiting log events</span>
    `
    logStream.appendChild(empty)
  }
})
