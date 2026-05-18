const tracesCountEl  = document.getElementById('traces-count')
const clearTracesBtn = document.getElementById('clear-traces')
const tracesListEl   = document.getElementById('obs-traces-list')

tracesListEl?.addEventListener('trace', (e) => {
  tracesListEl.addSpan(e.detail)
  if (document.querySelector('.obs-subtab[data-subtab="traces"].active')) {
    tracesListEl.render()
  }
  tracesCountEl.textContent = `${tracesListEl.size} trace${tracesListEl.size !== 1 ? 's' : ''}`
})

clearTracesBtn?.addEventListener('click', () => {
  tracesListEl?.clear()
  tracesCountEl.textContent = '0 traces'
})
