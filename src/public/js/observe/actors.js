import { updateTopics } from './topics.js'

const actorTreeEl    = document.getElementById('actor-tree')
const metricsSummary = document.getElementById('metrics-summary')
const sumActors      = document.getElementById('sum-actors')
const sumRecv        = document.getElementById('sum-recv')
const sumDone        = document.getElementById('sum-done')
const sumFail        = document.getElementById('sum-fail')
const actorDetailEl  = document.getElementById('actor-detail')

export const actorsMap = actorTreeEl?.actorsMap ?? {}

actorTreeEl?.addEventListener('actor-select', (e) => {
  actorDetailEl?.show(e.detail.actor)
})

export function updateMetrics(event) {
  const metricsEmpty = document.getElementById('metrics-empty')
  if (metricsEmpty?.parentNode) metricsEmpty.remove()

  const actors = event.actors || []
  let totRecv = 0, totDone = 0, totFail = 0
  actors.forEach(a => {
    totRecv += a.messagesReceived  || 0
    totDone += a.messagesProcessed || 0
    totFail += a.messagesFailed    || 0
  })

  if (actors.length > 0) {
    const isMetricsActive = !!document.querySelector('.obs-subtab[data-subtab="metrics"].active')
    metricsSummary.style.display = isMetricsActive ? 'flex' : 'none'
    sumActors.textContent = actors.length
    sumRecv.textContent   = totRecv
    sumDone.textContent   = totDone
    sumFail.textContent   = totFail
  }

  const selectedActor = actorTreeEl?.update(actors)
  if (selectedActor) actorDetailEl?.show(selectedActor)

  if (event.topics) updateTopics(event.topics)
}
