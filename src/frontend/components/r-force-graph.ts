import { html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { RorschachBase, escHtml } from './base.js';

declare const d3: any;

const LABEL_COLORS: Record<string, { stroke: string }> = {
  Entity:     { stroke: '#00c4d4' },
  Project:    { stroke: '#c4843a' },
  Concept:    { stroke: '#a064dc' },
  Preference: { stroke: '#e06030' },
  Goal:       { stroke: '#39e8a0' },
  Place:      { stroke: '#50b464' },
  Event:      { stroke: '#5ba0b8' },
  Habit:      { stroke: '#dcb428' },
};
const NODE_BG = '#060e14';
const DEFAULT_STROKE = '#1a3548';

export const formatKgEdgeLabel = (edge: { type?: unknown, properties?: Record<string, unknown> }) => {
  const type = typeof edge.type === 'string' && edge.type.length > 0 ? edge.type : 'link';
  const confidence = edge.properties?.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return type;
  return `${type} c=${confidence.toFixed(2)}`;
};

export const workflowTaskStatusClass = (status: unknown): string => {
  const value = typeof status === 'string' && status.length > 0 ? status : 'not_tracked';
  return `status-${value.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}`;
};

@customElement('r-force-graph')
export class RForceGraph extends RorschachBase {
  @property({ type: Object }) planData: any = null;
  @property({ type: String }) selectedTaskId: string | null = null;
  @property({ type: Object }) kgData: { nodes: any[], edges: any[] } | null = null;

  @state() private _hasData = false;
  private _sim: any = null;

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = 'block';
    this.style.width = '100%';
    this.style.height = '100%';
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._sim) {
      this._sim.stop();
      this._sim = null;
    }
  }

  override updated(changedProperties: Map<string, any>) {
    if ((changedProperties.has('planData') && this.planData) || 
        (changedProperties.has('kgData') && this.kgData)) {
      const nodes = this.planData?.nodes || this.kgData?.nodes || [];
      this._hasData = nodes.length > 0;
      if (this._hasData) {
        requestAnimationFrame(() => {
          if (this.planData) this._renderPlanGraphD3();
          else if (this.kgData) this._renderKnowledgeGraphD3();
        });
      }
    }

    if (changedProperties.has('selectedTaskId') && this._sim && this.planData) {
      this._updateSelection();
    }
  }

  override render() {
    if (!this._hasData) {
      return html`
        <slot>
          <r-empty-state variant="panel" name="network" text="no graph data"></r-empty-state>
        </slot>
      `;
    }
    return html`<div id="graph-container" style="width:100%; height:100%;"></div>`;
  }

  private _updateSelection() {
    d3.select(this).selectAll('.plan-node')
      .classed('selected', (d: any) => d.id === this.selectedTaskId);
  }

  private _renderKnowledgeGraphD3() {
    if (!this.kgData) return;
    if (typeof d3 === 'undefined') return;
    if (this._sim) this._sim.stop();
    const container = this.querySelector('#graph-container');
    if (!container) return;
    container.innerHTML = '';

    const { nodes, edges } = this.kgData;
    const host = this as HTMLElement;
    const width  = host.clientWidth || 600;
    const height = host.clientHeight || 400;
    const R = 22;

    const simNodes = nodes.map(n => ({ ...n }));
    const nodeById = Object.fromEntries(simNodes.map(n => [n.id, n]));
    const simEdges = edges
      .map(e => ({ ...e, source: nodeById[e.source], target: nodeById[e.target] }))
      .filter(e => e.source && e.target);

    const svg = d3.select(container).append('svg')
      .attr('width', '100%').attr('height', '100%');

    svg.append('defs').append('marker')
      .attr('id', 'kg-arrow')
      .attr('viewBox', '0 -4 8 8')
      .attr('refX', 8).attr('refY', 0)
      .attr('markerWidth', 6).attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', '#00c4d4');

    const g = svg.append('g');
    svg.call(d3.zoom().scaleExtent([0.15, 5]).on('zoom', (ev: any) => g.attr('transform', ev.transform)));

    const edgeLine = g.append('g').selectAll('line').data(simEdges).enter().append('line')
      .attr('stroke', '#00c4d4').attr('stroke-width', 1.5)
      .attr('marker-end', 'url(#kg-arrow)');

    const edgeLabel = g.append('g').selectAll('text').data(simEdges).enter().append('text')
      .text((d: any) => formatKgEdgeLabel(d))
      .attr('font-size', '9px').attr('fill', '#2a5468')
      .attr('text-anchor', 'middle').attr('font-family', 'var(--font-mono)')
      .attr('pointer-events', 'none');

    const tooltip = d3.select(container).append('div').attr('class', 'graph-tooltip');

    const nodeGroup = g.append('g').selectAll('g').data(simNodes).enter().append('g')
      .attr('cursor', 'grab')
      .call(d3.drag()
        .on('start', (ev: any, d: any) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag',  (ev: any, d: any) => { d.fx = ev.x; d.fy = ev.y; })
        .on('end',   (ev: any, d: any) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
      );

    nodeGroup.append('circle')
      .attr('r', R)
      .attr('fill',         () => NODE_BG)
      .attr('stroke',       (d: any) => (LABEL_COLORS[d.labels[0]] || { stroke: DEFAULT_STROKE }).stroke)
      .attr('stroke-width', 1.5);

    nodeGroup.append('text')
      .text((d: any) => String(d.properties.name || d.properties.topic || `#${d.id}`).slice(0, 12))
      .attr('text-anchor', 'middle').attr('dy', '0.35em')
      .attr('font-size', '10px').attr('fill', '#d8eef5')
      .attr('font-family', 'var(--font-mono)').attr('pointer-events', 'none');

    nodeGroup.append('text')
      .text((d: any) => d.labels[0] || '')
      .attr('text-anchor', 'middle').attr('dy', R + 14 + 'px')
      .attr('font-size', '8px').attr('fill', '#3d6878')
      .attr('font-family', 'var(--font-mono)').attr('pointer-events', 'none');

    nodeGroup
      .on('mouseover', (ev: any, d: any) => {
        const lines = Object.entries(d.properties).map(([k, v]) => `${k}: ${v}`).join('\n');
        tooltip.style('display', 'block')
          .html(`<strong>${escHtml(d.labels.join(' · '))}</strong><pre>${escHtml(lines)}</pre>`);
      })
      .on('mousemove', (ev: any) => {
        const rect = container.getBoundingClientRect();
        tooltip.style('left', (ev.clientX - rect.left + 14) + 'px')
               .style('top', (ev.clientY - rect.top - 14) + 'px');
      })
      .on('mouseout', () => tooltip.style('display', 'none'));

    const connectedIds = new Set(simEdges.flatMap(e => [e.source.id, e.target.id]));
    const isOrphan = (d: any) => !connectedIds.has(d.id);

    const sim = d3.forceSimulation(simNodes)
      .force('link',    d3.forceLink(simEdges).id((d: any) => d.id).distance(130))
      .force('charge',  d3.forceManyBody().strength(-200))
      .force('center',  d3.forceCenter(width / 2, height / 2))
      .force('x',       d3.forceX(width / 2).strength(0.05))
      .force('y',       d3.forceY(height / 2).strength(0.05))
      .force('collide', d3.forceCollide(R + 18))
      .force('orphan-x', d3.forceX(width / 2).strength((d: any) => isOrphan(d) ? 0.15 : 0))
      .force('orphan-y', d3.forceY(height / 2).strength((d: any) => isOrphan(d) ? 0.15 : 0))
      .on('tick', () => {
        edgeLine
          .attr('x1', (d: any) => d.source.x)
          .attr('y1', (d: any) => d.source.y)
          .attr('x2', (d: any) => {
            const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
            const dist = Math.sqrt(dx*dx + dy*dy) || 1;
            return d.target.x - (dx / dist) * (R + 10);
          })
          .attr('y2', (d: any) => {
            const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
            const dist = Math.sqrt(dx*dx + dy*dy) || 1;
            return d.target.y - (dy / dist) * (R + 10);
          });
        edgeLabel
          .attr('x', (d: any) => {
            const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
            const dist = Math.sqrt(dx*dx + dy*dy) || 1;
            return d.source.x + (dx / dist) * (R + 25);
          })
          .attr('y', (d: any) => {
            const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
            const dist = Math.sqrt(dx*dx + dy*dy) || 1;
            return d.source.y + (dy / dist) * (R + 25);
          })
          .attr('text-anchor', (d: any) => (d.target.x > d.source.x) ? 'start' : 'end');
        nodeGroup.attr('transform', (d: any) => `translate(${d.x},${d.y})`);
      });

    this._sim = sim;
  }

  private _renderPlanGraphD3() {
    if (!this.planData) return;
    if (typeof d3 === 'undefined') return;
    if (this._sim) this._sim.stop();
    const container = this.querySelector('#graph-container');
    if (!container) return;
    container.innerHTML = '';

    const host = this as HTMLElement;
    const width  = Math.max(host.clientWidth, 320);
    const height = Math.max(host.clientHeight, 260);
    const nodeById = Object.fromEntries(this.planData.nodes.map((node: any) => [node.id, { ...node }]));
    const nodes = Object.values(nodeById);
    const edges = this.planData.edges
      .map((edge: any) => ({ ...edge, source: nodeById[edge.source], target: nodeById[edge.target] }))
      .filter((edge: any) => edge.source && edge.target);

    const hasIncoming = new Set(edges.map((e: any) => e.target.id));
    const hasOutgoing = new Set(edges.map((e: any) => e.source.id));

    const svg = d3.select(container).append('svg')
      .attr('width', '100%').attr('height', '100%');

    svg.append('defs').append('marker')
      .attr('id', 'plan-arrow')
      .attr('viewBox', '0 -4 8 8')
      .attr('refX', 8).attr('refY', 0)
      .attr('markerWidth', 6).attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', '#00c4d4');

    const g = svg.append('g');
    svg.call(d3.zoom().scaleExtent([0.25, 4]).on('zoom', (ev: any) => g.attr('transform', ev.transform)));

    const link = g.append('g').selectAll('line').data(edges).enter().append('line')
      .attr('stroke', '#1e5264')
      .attr('stroke-width', 1.4)
      .attr('marker-end', 'url(#plan-arrow)');

    const shortLabel = (value: string, max = 18) => {
      const text = String(value || '');
      return text.length > max ? `${text.slice(0, max - 1)}…` : text;
    };

    const node = g.append('g').selectAll('g').data(nodes).enter().append('g')
      .attr('class', (d: any) => {
        let cls = `plan-node ${workflowTaskStatusClass(d.status)}`;
        if (d.id === this.selectedTaskId) cls += ' selected';
        if (!hasIncoming.has(d.id) && hasOutgoing.has(d.id)) cls += ' source';
        if (hasIncoming.has(d.id) && !hasOutgoing.has(d.id)) cls += ' sink';
        return cls;
      })
      .attr('cursor', 'pointer')
      .call(d3.drag()
        .on('start', (ev: any, d: any) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag',  (ev: any, d: any) => { d.fx = ev.x; d.fy = ev.y; })
        .on('end',   (ev: any, d: any) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
      )
      .on('click', (_ev: any, d: any) => {
        this.dispatchEvent(new CustomEvent('node-select', { detail: { id: d.id } }));
      });

    node.append('rect')
      .attr('x', -62).attr('y', -22)
      .attr('width', 124).attr('height', 44)
      .attr('rx', 6);

    node.append('text')
      .text((d: any) => shortLabel(d.label))
      .attr('text-anchor', 'middle').attr('dy', '0.3em')
      .attr('font-size', '10px').attr('font-family', 'var(--font-mono)');

    const sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(edges).id((d: any) => d.id).distance(135).strength(0.7))
      .force('charge', d3.forceManyBody().strength(-320))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('x', d3.forceX(width / 2).strength(0.06))
      .force('y', d3.forceY(height / 2).strength(0.08))
      .force('collide', d3.forceCollide(76))
      .on('tick', () => {
        link
          .attr('x1', (d: any) => d.source.x)
          .attr('y1', (d: any) => d.source.y)
          .attr('x2', (d: any) => {
            const dx = d.target.x - d.source.x;
            const dy = d.target.y - d.source.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            return d.target.x - (dx / dist) * 68;
          })
          .attr('y2', (d: any) => {
            const dx = d.target.x - d.source.x;
            const dy = d.target.y - d.source.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            return d.target.y - (dy / dist) * 28;
          });
        node.attr('transform', (d: any) => `translate(${d.x},${d.y})`);
      });

    this._sim = sim;
  }
}
