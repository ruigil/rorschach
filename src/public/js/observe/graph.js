import { state } from '../state.js'
import { escHtml } from '../utils.js'

const LABEL_COLORS = {
  Person:     { fill: 'rgba(0,196,212,0.12)',  stroke: '#00c4d4' },
  User:       { fill: 'rgba(57,232,160,0.12)', stroke: '#39e8a0' },
  Project:    { fill: 'rgba(196,132,58,0.12)', stroke: '#c4843a' },
  Event:      { fill: 'rgba(91,160,184,0.12)', stroke: '#5ba0b8' },
  Preference: { fill: 'rgba(224,96,48,0.12)',  stroke: '#e06030' },
}
const DEFAULT_NODE_COLOR = { fill: 'rgba(10,24,32,0.5)', stroke: '#1a3548' }

function nodeColor(label)       { return (LABEL_COLORS[label] || DEFAULT_NODE_COLOR).fill }
function nodeColorStroke(label) { return (LABEL_COLORS[label] || DEFAULT_NODE_COLOR).stroke }

export async function fetchKgraph() {
  const statsEl = document.getElementById('memory-stats')
  statsEl.textContent = 'loading…'
  try {
    const res    = await fetch(new URL('kgraph', location.href))
    const graph  = await res.json()
    const userId = state.currentUserId || 'default'
    const filtered = filterKgraphFromRoot(graph, userId)
    renderKgraph(filtered)
    statsEl.textContent = `${filtered.nodes.length} nodes · ${filtered.edges.length} edges`
  } catch {
    statsEl.textContent = 'error'
  }
}

function filterKgraphFromRoot(graph, userId) {
  const { nodes, edges } = graph
  const rootNode = nodes.find(n => n.properties?.name === userId)
  if (!rootNode) return graph

  const reachable = new Set([rootNode.id])
  const queue = [rootNode.id]
  while (queue.length) {
    const current = queue.shift()
    for (const e of edges) {
      if (e.source === current && !reachable.has(e.target)) {
        reachable.add(e.target)
        queue.push(e.target)
      }
    }
  }

  return {
    nodes: nodes.filter(n => reachable.has(n.id)),
    edges: edges.filter(e => reachable.has(e.source) && reachable.has(e.target)),
  }
}

function renderKgraph(graph) {
  const container = document.getElementById('memory-graph')
  container.innerHTML = ''

  const { nodes, edges } = graph

  if (nodes.length === 0) {
    container.innerHTML = `<div class="empty-panel"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><circle cx="5" cy="12" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><line x1="7" y1="11.5" x2="17" y2="6.5"/><line x1="7" y1="12.5" x2="17" y2="17.5"/></svg><span>no graph data</span></div>`
    return
  }

  const width  = container.clientWidth
  const height = container.clientHeight
  const R = 22

  const simNodes = nodes.map(n => ({ ...n }))
  const nodeById = Object.fromEntries(simNodes.map(n => [n.id, n]))
  const simEdges = edges
    .map(e => ({ ...e, source: nodeById[e.source], target: nodeById[e.target] }))
    .filter(e => e.source && e.target)

  const svg = d3.select(container).append('svg')
    .attr('width', '100%').attr('height', '100%')

  svg.append('defs').append('marker')
    .attr('id', 'kg-arrow')
    .attr('viewBox', '0 -4 8 8')
    .attr('refX', 8).attr('refY', 0)
    .attr('markerWidth', 6).attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', '#2a5468')

  const g = svg.append('g')
  svg.call(d3.zoom().scaleExtent([0.15, 5]).on('zoom', ev => g.attr('transform', ev.transform)))

  const edgeLine = g.append('g').selectAll('line').data(simEdges).enter().append('line')
    .attr('stroke', '#1e3f54').attr('stroke-width', 1.5)
    .attr('marker-end', 'url(#kg-arrow)')

  const edgeLabel = g.append('g').selectAll('text').data(simEdges).enter().append('text')
    .text(d => d.type)
    .attr('font-size', '9px').attr('fill', '#2a5468')
    .attr('text-anchor', 'middle').attr('font-family', 'var(--font-mono)')
    .attr('pointer-events', 'none')

  const tooltip = d3.select(container).append('div').attr('class', 'graph-tooltip').style('display', 'none')

  const nodeGroup = g.append('g').selectAll('g').data(simNodes).enter().append('g')
    .attr('cursor', 'grab')
    .call(d3.drag()
      .on('start', (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y })
      .on('drag',  (ev, d) => { d.fx = ev.x; d.fy = ev.y })
      .on('end',   (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null })
    )

  nodeGroup.append('circle')
    .attr('r', R)
    .attr('fill',         d => nodeColor(d.labels[0]))
    .attr('stroke',       d => nodeColorStroke(d.labels[0]))
    .attr('stroke-width', 1.5)

  nodeGroup.append('text')
    .text(d => String(d.properties.name || d.properties.topic || `#${d.id}`).slice(0, 12))
    .attr('text-anchor', 'middle').attr('dy', '0.35em')
    .attr('font-size', '10px').attr('fill', '#d8eef5')
    .attr('font-family', 'var(--font-mono)').attr('pointer-events', 'none')

  nodeGroup.append('text')
    .text(d => d.labels[0] || '')
    .attr('text-anchor', 'middle').attr('dy', R + 14 + 'px')
    .attr('font-size', '8px').attr('fill', '#3d6878')
    .attr('font-family', 'var(--font-mono)').attr('pointer-events', 'none')

  nodeGroup
    .on('mouseover', (ev, d) => {
      const lines = Object.entries(d.properties).map(([k, v]) => `${k}: ${v}`).join('\n')
      tooltip.style('display', 'block')
        .html(`<strong>${escHtml(d.labels.join(' · '))}</strong><pre>${escHtml(lines)}</pre>`)
    })
    .on('mousemove', ev => {
      const rect = container.getBoundingClientRect()
      tooltip.style('left', (ev.clientX - rect.left + 14) + 'px').style('top', (ev.clientY - rect.top - 14) + 'px')
    })
    .on('mouseout', () => tooltip.style('display', 'none'))

  const sim = d3.forceSimulation(simNodes)
    .force('link',    d3.forceLink(simEdges).id(d => d.id).distance(130))
    .force('charge',  d3.forceManyBody().strength(-320))
    .force('center',  d3.forceCenter(width / 2, height / 2))
    .force('collide', d3.forceCollide(R + 18))
    .on('tick', () => {
      edgeLine
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => {
          const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y
          const dist = Math.sqrt(dx*dx + dy*dy) || 1
          return d.target.x - (dx / dist) * (R + 10)
        })
        .attr('y2', d => {
          const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y
          const dist = Math.sqrt(dx*dx + dy*dy) || 1
          return d.target.y - (dy / dist) * (R + 10)
        })
      edgeLabel
        .attr('x', d => (d.source.x + d.target.x) / 2)
        .attr('y', d => (d.source.y + d.target.y) / 2 - 5)
      nodeGroup.attr('transform', d => `translate(${d.x},${d.y})`)
    })
}
