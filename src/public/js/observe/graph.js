const memoryGraph = document.getElementById('memory-graph')
const statsEl     = document.getElementById('memory-stats')

export async function fetchKgraph() {
  statsEl.textContent = 'loading…'
  try {
    const res   = await fetch(new URL('kgraph', location.href))
    const graph = await res.json()
    memoryGraph?.renderKnowledgeGraph(graph)
    statsEl.textContent = `${graph.nodes.length} nodes · ${graph.edges.length} edges`
  } catch {
    statsEl.textContent = 'error'
  }
}
