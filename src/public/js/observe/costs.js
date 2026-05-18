const costsEl = document.getElementById('obs-costs')

costsEl?.addEventListener('usage', (e) => {
  costsEl.addUsage(e.detail)
  if (costsEl.classList.contains('active')) costsEl.render()
})
