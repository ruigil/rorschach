const costsEl = document.getElementById('obs-costs')

export function onUsageMsg(msg) {
  if (!costsEl) return
  costsEl.addUsage(msg)
  if (costsEl.classList.contains('active')) costsEl.render()
}

export function renderCostsTable() {
  costsEl?.render()
}
