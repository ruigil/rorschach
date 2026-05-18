import { fetchKgraph } from './graph.js'
import { renderCostsTable } from './costs.js'
import { actorsMap } from './actors.js'

const metricsSummary    = document.getElementById('metrics-summary')
const obsLogControls    = document.getElementById('obs-log-controls')
const obsTracesControls = document.getElementById('obs-traces-controls')
const obsMemoryControls = document.getElementById('obs-memory-controls')

const obsTabs = document.querySelector('r-tabs.obs-subtabs')
obsTabs?.addEventListener('tab-change', (e) => {
  const subtab = e.detail.tab
  document.querySelectorAll('.obs-subpanel').forEach(p => p.classList.remove('active'))
  document.getElementById('obs-' + subtab)?.classList.add('active')

  metricsSummary.style.display    = subtab === 'metrics' && Object.keys(actorsMap).length > 0 ? 'flex' : 'none'
  obsLogControls.style.display    = subtab === 'logs'    ? 'flex' : 'none'
  obsTracesControls.style.display = subtab === 'traces'  ? 'flex' : 'none'
  obsMemoryControls.style.display = subtab === 'memory'  ? 'flex' : 'none'

  if (subtab === 'traces') document.getElementById('obs-traces-list')?.render()
  if (subtab === 'memory') fetchKgraph()
  if (subtab === 'costs')  renderCostsTable()
})

document.getElementById('memory-refresh')?.addEventListener('click', fetchKgraph)
