const logStream  = document.getElementById('log-stream')
const logCountEl = document.getElementById('log-count')
const clearBtn   = document.getElementById('clear-logs')

logStream?.addEventListener('log', (e) => {
  const count = logStream.append(e.detail)
  logCountEl.textContent = `${count} event${count !== 1 ? 's' : ''}`
})

clearBtn?.addEventListener('click', () => {
  logStream?.clear()
  logCountEl.textContent = '0 events'
})
