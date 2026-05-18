import { state } from '../state.js'
import { escHtml } from '../utils.js'

const LABEL_COLORS = {
  Entity:     { stroke: '#00c4d4' },
  Project:    { stroke: '#c4843a' },
  Concept:    { stroke: '#a064dc' },
  Preference: { stroke: '#e06030' },
  Goal:       { stroke: '#39e8a0' },
  Place:      { stroke: '#50b464' },
  Event:      { stroke: '#5ba0b8' },
  Habit:      { stroke: '#dcb428' },
}
const NODE_BG = '#060e14'
const DEFAULT_STROKE = '#1a3548'

function nodeColor()            { return NODE_BG }
function nodeColorStroke(label) { return (LABEL_COLORS[label] || { stroke: DEFAULT_STROKE }).stroke }

export async function fetchKgraph() {
  const statsEl = document.getElementById('memory-stats')
  statsEl.textContent = 'loading…'
  try {
    const res   = await fetch(new URL('kgraph', location.href))
    const graph = await res.json()
    renderKgraph(graph)
    statsEl.textContent = `${graph.nodes.length} nodes · ${graph.edges.length} edges`
  } catch {
    statsEl.textContent = 'error'
  }
}


function renderKgraph(graph) {
  const container = document.getElementById('memory-graph')
  container.innerHTML = ''

  const { nodes, edges } = graph

  if (nodes.length === 0) {
    container.innerHTML = `<r-empty-state variant="panel" icon="<svg width=&quot;28&quot; height=&quot;28&quot; viewBox=&quot;0 0 24 24&quot; fill=&quot;none&quot; stroke=&quot;currentColor&quot; stroke-width=&quot;1&quot;><circle cx=&quot;5&quot; cy=&quot;12&quot; r=&quot;2&quot;/><circle cx=&quot;19&quot; cy=&quot;5&quot; r=&quot;2&quot;/><circle cx=&quot;19&quot; cy=&quot;19&quot; r=&quot;2&quot;/><line x1=&quot;7&quot; y1=&quot;11.5&quot; x2=&quot;17&quot; y2=&quot;6.5&quot;/><line x1=&quot;7&quot; y1=&quot;12.5&quot; x2=&quot;17&quot; y2=&quot;17.5&quot;/></svg>" text="no graph data"></r-empty-state>`
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
    .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', '#00c4d4')

  const g = svg.append('g')
  svg.call(d3.zoom().scaleExtent([0.15, 5]).on('zoom', ev => g.attr('transform', ev.transform)))

  const edgeLine = g.append('g').selectAll('line').data(simEdges).enter().append('line')
    .attr('stroke', '#00c4d4').attr('stroke-width', 1.5)
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

  const connectedIds = new Set(simEdges.flatMap(e => [e.source.id, e.target.id]))
  const isOrphan = d => !connectedIds.has(d.id)

  const sim = d3.forceSimulation(simNodes)
    .force('link',    d3.forceLink(simEdges).id(d => d.id).distance(130))
    .force('charge',  d3.forceManyBody().strength(-200))
    .force('center',  d3.forceCenter(width / 2, height / 2))
    .force('x',       d3.forceX(width / 2).strength(0.05))
    .force('y',       d3.forceY(height / 2).strength(0.05))
    .force('collide', d3.forceCollide(R + 18))
    .force('orphan-x', d3.forceX(width / 2).strength(d => isOrphan(d) ? 0.15 : 0))
    .force('orphan-y', d3.forceY(height / 2).strength(d => isOrphan(d) ? 0.15 : 0))
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
        .attr('x', d => {
          const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y
          const dist = Math.sqrt(dx*dx + dy*dy) || 1
          return d.source.x + (dx / dist) * (R + 25)
        })
        .attr('y', d => {
          const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y
          const dist = Math.sqrt(dx*dx + dy*dy) || 1
          return d.source.y + (dy / dist) * (R + 25)
        })
        .attr('text-anchor', d => (d.target.x > d.source.x) ? 'start' : 'end')
      nodeGroup.attr('transform', d => `translate(${d.x},${d.y})`)
    })
}
