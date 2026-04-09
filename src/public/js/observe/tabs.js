import { renderTraces } from './traces.js'
import { fetchKgraph } from './graph.js'
import { renderCostsTable } from './costs.js'
import { actorsMap } from './actors.js'

const metricsSummary    = document.getElementById('metrics-summary')
const obsLogControls    = document.getElementById('obs-log-controls')
const obsTracesControls = document.getElementById('obs-traces-controls')
const obsMemoryControls = document.getElementById('obs-memory-controls')

document.querySelectorAll('.obs-subtab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.obs-subtab').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    document.querySelectorAll('.obs-subpanel').forEach(p => p.classList.remove('active'))
    document.getElementById('obs-' + btn.dataset.subtab).classList.add('active')

    const subtab = btn.dataset.subtab
    metricsSummary.style.display    = subtab === 'metrics' && Object.keys(actorsMap).length > 0 ? 'flex' : 'none'
    obsLogControls.style.display    = subtab === 'logs'    ? 'flex' : 'none'
    obsTracesControls.style.display = subtab === 'traces'  ? 'flex' : 'none'
    obsMemoryControls.style.display = subtab === 'memory'  ? 'flex' : 'none'

    if (subtab === 'traces') renderTraces()
    if (subtab === 'memory') fetchKgraph()
    if (subtab === 'costs')  renderCostsTable()
  })
})

document.getElementById('memory-refresh').addEventListener('click', fetchKgraph)
