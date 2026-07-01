import { html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { RorschachBase, escHtml } from './base.js';
import * as d3 from 'd3';

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
const NODE_BG = 'var(--surface)';
const DEFAULT_STROKE = 'var(--border-mid)';

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

// ─── Graph strategy config ───
// The two graph types (knowledge-graph and plan-graph) share ~80% of the D3
// render logic. This config captures only the differences.

type GraphConfig = {
  arrowId: string;
  zoomExtent: [number, number];
  edgeStroke: string;
  edgeWidth: number;
  hasEdgeLabels: boolean;
  nodeRadius: number;
  collideRadius: number;
  linkDistance: number;
  linkStrength: number;
  chargeStrength: number;
  xStrength: number;
  yStrength: number;
  hasOrphanForce: boolean;
  edgeOffsetX: number;
  edgeOffsetY: number;
  appendNodeShape: (ng: any, d: any) => void;
  nodeClass: (d: any, selectedTaskId: string | null, hasIncoming: Set<any>, hasOutgoing: Set<any>) => string;
  nodeCursor: string;
  onNodeInteraction: (ng: any, tooltip: any, container: Element) => void;
};

const KG_CONFIG: GraphConfig = {
  arrowId: 'kg-arrow',
  zoomExtent: [0.15, 5],
  edgeStroke: 'var(--accent)',
  edgeWidth: 1.5,
  hasEdgeLabels: true,
  nodeRadius: 22,
  collideRadius: 40,
  linkDistance: 130,
  linkStrength: 1,
  chargeStrength: -200,
  xStrength: 0.05,
  yStrength: 0.05,
  hasOrphanForce: true,
  edgeOffsetX: 32,
  edgeOffsetY: 32,
  appendNodeShape: (ng, d) => {
    ng.append('circle')
      .attr('r', 22)
      .attr('fill', () => NODE_BG)
      .attr('stroke', (d: any) => (LABEL_COLORS[d.labels[0]] || { stroke: DEFAULT_STROKE }).stroke)
      .attr('stroke-width', 1.5);
    ng.append('text')
      .text((d: any) => String(d.properties.name || d.properties.topic || `#${d.id}`).slice(0, 12))
      .attr('text-anchor', 'middle').attr('dy', '0.35em')
      .attr('font-size', '10px').attr('fill', 'var(--text)')
      .attr('font-family', 'var(--font-mono)').attr('pointer-events', 'none');
    ng.append('text')
      .text((d: any) => d.labels[0] || '')
      .attr('text-anchor', 'middle').attr('dy', '36px')
      .attr('font-size', '8px').attr('fill', 'var(--text-dim)')
      .attr('font-family', 'var(--font-mono)').attr('pointer-events', 'none');
  },
  nodeClass: () => '',
  nodeCursor: 'grab',
  onNodeInteraction: (ng, tooltip, container) => {
    ng
      .on('mouseover', (_ev: any, d: any) => {
        const lines = Object.entries(d.properties).map(([k, v]) => `${k}: ${v}`).join('\n');
        tooltip.style('display', 'block')
          .html(`<strong>${escHtml(d.labels.join(' · '))}</strong><pre>${escHtml(lines)}</pre>`);
      })
      .on('mousemove', (ev: any) => {
        const rect = (container as HTMLElement).getBoundingClientRect();
        tooltip.style('left', (ev.clientX - rect.left + 14) + 'px')
               .style('top', (ev.clientY - rect.top - 14) + 'px');
      })
      .on('mouseout', () => tooltip.style('display', 'none'));
  },
};

const PLAN_CONFIG: GraphConfig = {
  arrowId: 'plan-arrow',
  zoomExtent: [0.25, 4],
  edgeStroke: 'var(--border-mid)',
  edgeWidth: 1.4,
  hasEdgeLabels: false,
  nodeRadius: 22,
  collideRadius: 76,
  linkDistance: 135,
  linkStrength: 0.7,
  chargeStrength: -320,
  xStrength: 0.06,
  yStrength: 0.08,
  hasOrphanForce: false,
  edgeOffsetX: 68,
  edgeOffsetY: 28,
  appendNodeShape: (ng, d) => {
    const shortLabel = (value: string, max = 18) => {
      const text = String(value || '');
      return text.length > max ? `${text.slice(0, max - 1)}…` : text;
    };
    ng.append('rect')
      .attr('x', -62).attr('y', -22)
      .attr('width', 124).attr('height', 44)
      .attr('rx', 6);
    ng.append('text')
      .text((d: any) => shortLabel(d.label))
      .attr('text-anchor', 'middle').attr('dy', '0.3em')
      .attr('font-size', '10px').attr('font-family', 'var(--font-mono)');
  },
  nodeClass: (d, selectedTaskId, hasIncoming, hasOutgoing) => {
    let cls = `plan-node ${workflowTaskStatusClass(d.status)}`;
    if (d.id === selectedTaskId) cls += ' selected';
    if (!hasIncoming.has(d.id) && hasOutgoing.has(d.id)) cls += ' source';
    if (hasIncoming.has(d.id) && !hasOutgoing.has(d.id)) cls += ' sink';
    return cls;
  },
  nodeCursor: 'pointer',
  onNodeInteraction: (ng, _tooltip, _container) => {
    ng.on('click', (_ev: any, d: any) => {
      d3.select(ng.node().ownerDocument).node();
      // Dispatch via the host element
      ng.node()?.closest('r-force-graph')?.dispatchEvent(
        new CustomEvent('node-select', { detail: { id: d.id } })
      );
    });
  },
};

@customElement('r-force-graph')
export class RForceGraph extends RorschachBase {
  @property({ type: Object }) planData: any = null;
  @property({ type: String }) selectedTaskId: string | null = null;
  @property({ type: Object }) kgData: { nodes: any[], edges: any[] } | null = null;

  @state() private _hasData = false;
  private _sim: any = null;

  static override styles = css`
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    :host svg {
      display: block;
      width: 100%;
      height: 100%;
    }
    #graph-container {
      width: 100%;
      height: 100%;
    }
    .graph-tooltip {
      position: absolute;
      pointer-events: none;
      background: var(--surface-2);
      border: 1px solid var(--border-mid);
      border-radius: var(--radius);
      padding: 8px 10px;
      font-family: var(--font-mono);
      font-size: 0.7rem;
      color: var(--text);
      max-width: 260px;
      z-index: 10;
      line-height: 1.5;
    }
    .graph-tooltip strong {
      display: block;
      color: var(--accent);
      margin-bottom: 4px;
      font-size: 0.72rem;
    }
    .graph-tooltip pre {
      margin: 0;
      color: var(--text-dim);
      white-space: pre-wrap;
      word-break: break-all;
    }

    /* ─── Plan graph node styles ───
       These lived in workspace.css when r-force-graph was light DOM.
       They must be in shadow DOM now that the SVG is encapsulated. */
    .plan-node rect {
      fill: var(--surface);
      stroke: var(--border-mid);
      stroke-width: 1.2px;
    }
    .plan-node.source rect {
      stroke: var(--green);
      stroke-width: 1.8px;
    }
    .plan-node.sink rect {
      stroke: var(--error);
      stroke-width: 1.8px;
    }
    .plan-node.selected rect {
      stroke: var(--accent);
      stroke-width: 2px;
      filter: drop-shadow(0 0 8px var(--accent-glow));
    }
    .plan-node.status-pending rect {
      stroke: var(--border-mid);
      fill: var(--surface-2);
    }
    .plan-node.status-running rect {
      fill: var(--accent-dim);
      stroke: var(--accent);
      stroke-width: 2px;
      filter: drop-shadow(0 0 8px var(--accent-glow));
    }
    .plan-node.status-completed rect {
      stroke: var(--green);
      stroke-width: 1.8px;
    }
    .plan-node.status-blocked rect {
      stroke: var(--warn);
      stroke-width: 1.8px;
    }
    .plan-node.status-failed rect {
      stroke: var(--error);
      stroke-width: 1.8px;
    }
    .plan-node text {
      fill: var(--text);
      pointer-events: none;
    }
  `;

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
        requestAnimationFrame(() => this._renderGraphD3());
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
    (d3.select(this.renderRoot as any) as any).selectAll('.plan-node')
      .classed('selected', (d: any) => d.id === this.selectedTaskId);
  }

  // ─── Unified D3 render ───
  //
  // Both graph types share the same skeleton: SVG + zoom + arrow marker +
  // force simulation + tick handler. A `GraphConfig` strategy captures the
  // differences (node shape, edge styling, interaction, force params).

  private _renderGraphD3() {
    const isPlan = !!this.planData;
    const data = isPlan ? this.planData : this.kgData;
    if (!data) return;
    const cfg = isPlan ? PLAN_CONFIG : KG_CONFIG;

    if (this._sim) { this._sim.stop(); this._sim = null; }
    const container = this.renderRoot.querySelector('#graph-container');
    if (!container) return;
    container.innerHTML = '';

    const host = this as HTMLElement;
    const width = Math.max(host.clientWidth || 600, isPlan ? 320 : 0);
    const height = Math.max(host.clientHeight || 400, isPlan ? 260 : 0);

    // Prepare nodes/edges
    const simNodes = data.nodes.map((n: any) => ({ ...n }));
    const nodeById = Object.fromEntries(simNodes.map((n: any) => [n.id, n]));
    const simEdges = data.edges
      .map((e: any) => ({ ...e, source: nodeById[e.source], target: nodeById[e.target] }))
      .filter((e: any) => e.source && e.target);

    const hasIncoming = new Set(simEdges.map((e: any) => e.target.id));
    const hasOutgoing = new Set(simEdges.map((e: any) => e.source.id));

    // SVG + zoom + marker
    const svg = d3.select(container).append('svg')
      .attr('width', '100%').attr('height', '100%');

    svg.append('defs').append('marker')
      .attr('id', cfg.arrowId)
      .attr('viewBox', '0 -4 8 8')
      .attr('refX', 8).attr('refY', 0)
      .attr('markerWidth', 6).attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', cfg.edgeStroke);

    const g = svg.append('g');
    svg.call(d3.zoom().scaleExtent(cfg.zoomExtent).on('zoom', (ev: any) => g.attr('transform', ev.transform)) as any);

    // Edges
    const edgeLine = g.append('g').selectAll('line').data(simEdges).enter().append('line')
      .attr('stroke', cfg.edgeStroke)
      .attr('stroke-width', cfg.edgeWidth)
      .attr('marker-end', `url(#${cfg.arrowId})`);

    let edgeLabel: any = null;
    if (cfg.hasEdgeLabels) {
      edgeLabel = g.append('g').selectAll('text').data(simEdges).enter().append('text')
        .text((d: any) => formatKgEdgeLabel(d))
        .attr('font-size', '9px').attr('fill', 'var(--text-dim)')
        .attr('text-anchor', 'middle').attr('font-family', 'var(--font-mono)')
        .attr('pointer-events', 'none');
    }

    // Tooltip (KG only uses it, but create it unconditionally for simplicity)
    const tooltip = d3.select(container).append('div').attr('class', 'graph-tooltip');

    // Nodes
    const nodeGroup = g.append('g').selectAll('g').data(simNodes).enter().append('g')
      .attr('class', (d: any) => cfg.nodeClass(d, this.selectedTaskId, hasIncoming, hasOutgoing))
      .attr('cursor', cfg.nodeCursor)
      .call((d3.drag() as any)
        .on('start', (ev: any, d: any) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag', (ev: any, d: any) => { d.fx = ev.x; d.fy = ev.y; })
        .on('end', (ev: any, d: any) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
      );

    cfg.appendNodeShape(nodeGroup, simNodes);
    cfg.onNodeInteraction(nodeGroup, tooltip, container);

    // Force simulation
    const sim = d3.forceSimulation(simNodes)
      .force('link', d3.forceLink(simEdges).id((d: any) => d.id).distance(cfg.linkDistance).strength(cfg.linkStrength))
      .force('charge', d3.forceManyBody().strength(cfg.chargeStrength))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('x', d3.forceX(width / 2).strength(cfg.xStrength))
      .force('y', d3.forceY(height / 2).strength(cfg.yStrength))
      .force('collide', d3.forceCollide(cfg.collideRadius));

    if (cfg.hasOrphanForce) {
      const connectedIds = new Set(simEdges.flatMap((e: any) => [e.source.id, e.target.id]));
      const isOrphan = (d: any) => !connectedIds.has(d.id);
      sim.force('orphan-x', d3.forceX(width / 2).strength((d: any) => isOrphan(d) ? 0.15 : 0));
      sim.force('orphan-y', d3.forceY(height / 2).strength((d: any) => isOrphan(d) ? 0.15 : 0));
    }

    sim.on('tick', () => {
      const ox = cfg.edgeOffsetX;
      const oy = cfg.edgeOffsetY;
      edgeLine
        .attr('x1', (d: any) => d.source.x)
        .attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => {
          const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          return d.target.x - (dx / dist) * ox;
        })
        .attr('y2', (d: any) => {
          const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          return d.target.y - (dy / dist) * oy;
        });
      if (edgeLabel) {
        edgeLabel
          .attr('x', (d: any) => {
            const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            return d.source.x + (dx / dist) * (cfg.nodeRadius + 25);
          })
          .attr('y', (d: any) => {
            const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            return d.source.y + (dy / dist) * (cfg.nodeRadius + 25);
          })
          .attr('text-anchor', (d: any) => (d.target.x > d.source.x) ? 'start' : 'end');
      }
      nodeGroup.attr('transform', (d: any) => `translate(${d.x},${d.y})`);
    });

    this._sim = sim;
  }
}
