const logStream  = document.getElementById('log-stream')
const logCountEl = document.getElementById('log-count')
const clearBtn   = document.getElementById('clear-logs')

export function appendLog(event) {
  if (!logStream) return
  const count = logStream.append(event)
  logCountEl.textContent = `${count} event${count !== 1 ? 's' : ''}`
}

clearBtn?.addEventListener('click', () => {
  logStream?.clear()
  logCountEl.textContent = '0 events'
})
