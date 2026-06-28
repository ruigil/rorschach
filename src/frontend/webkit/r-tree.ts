import { html, css, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import './r-icon.js';
import { type IconName } from './icons.js';

export interface TreeNode<T = any> {
  id: string;
  label: string;
  children?: TreeNode<T>[];
  icon?: IconName;
  status?: 'running' | 'stopped' | 'error' | 'warn' | 'info' | string;
  badge?: string | number;
  data?: T;
}

@customElement('r-tree')
export class RTree extends RorschachBase {
  @property({ type: Array }) data: TreeNode[] = [];
  @property({ type: String }) selectedId: string | null = null;
  @property({ type: Boolean }) defaultCollapsed = false;
  @state() private _collapsedSet = new Set<string>();
  @state() private _expandedSet = new Set<string>();

  static override styles = css`
    :host {
      display: block;
      font-family: var(--font-ui, sans-serif);
    }

    .tree-node {
      display: flex;
      flex-direction: column;
    }

    .tree-row {
      display: flex;
      align-items: center;
      padding: 4px 6px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.75rem;
      transition: background 0.15s, color 0.15s;
      user-select: none;
    }

    .tree-row:hover {
      background: rgba(0, 196, 212, 0.04);
    }

    .tree-row.selected {
      background: rgba(0, 196, 212, 0.08);
      color: var(--accent, #00c4d4);
      font-weight: 500;
    }

    .tree-chevron {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      color: var(--text-dim, #3d6878);
      cursor: pointer;
      margin-right: 4px;
      border-radius: 2px;
    }

    .tree-chevron:hover {
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-mid, #8abccc);
    }

    .tree-spacer {
      width: 16px;
      margin-right: 4px;
    }

    .tree-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--text-dim, #3d6878);
      margin-right: 6px;
    }

    .tree-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      margin-right: 8px;
      flex-shrink: 0;
    }

    .tree-dot.running, .tree-dot.completed, .tree-dot.success {
      background: var(--green, #39e8a0);
      box-shadow: 0 0 4px var(--green-glow, rgba(57, 232, 160, 0.4));
    }

    .tree-dot.stopped, .tree-dot.idle {
      background: var(--text-dim, #3d6878);
    }

    .tree-dot.error, .tree-dot.failed {
      background: var(--error, #e06030);
      box-shadow: 0 0 4px var(--error, #e06030);
    }

    .tree-dot.warn, .tree-dot.blocked {
      background: var(--warn, #c4843a);
    }

    .tree-dot-empty {
      width: 6px;
      height: 6px;
      margin-right: 8px;
      flex-shrink: 0;
    }

    .tree-label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tree-badge {
      font-family: var(--font-mono, monospace);
      font-size: 0.65rem;
      color: var(--text-dim, #3d6878);
      background: rgba(255, 255, 255, 0.04);
      padding: 1px 5px;
      border-radius: 8px;
      margin-left: 8px;
    }
  `;


  private _toggleCollapse(node: TreeNode, e: Event) {
    e.stopPropagation();
    let collapsed = false;
    if (this.defaultCollapsed) {
      collapsed = this._expandedSet.has(node.id);
      if (collapsed) {
        this._expandedSet.delete(node.id);
      } else {
        this._expandedSet.add(node.id);
      }
    } else {
      collapsed = !this._collapsedSet.has(node.id);
      if (collapsed) {
        this._collapsedSet.add(node.id);
      } else {
        this._collapsedSet.delete(node.id);
      }
    }
    this.requestUpdate();

    this.dispatchEvent(new CustomEvent('node-toggle', {
      bubbles: true,
      composed: true,
      detail: { node, collapsed }
    }));
  }

  private _onRowClick(node: TreeNode) {
    if (node.children && node.children.length > 0 && !node.data) {
      // Toggle collapse state if it's a structural folder with no data payload
      let collapsed = false;
      if (this.defaultCollapsed) {
        collapsed = this._expandedSet.has(node.id);
        if (collapsed) {
          this._expandedSet.delete(node.id);
        } else {
          this._expandedSet.add(node.id);
        }
      } else {
        collapsed = !this._collapsedSet.has(node.id);
        if (collapsed) {
          this._collapsedSet.add(node.id);
        } else {
          this._collapsedSet.delete(node.id);
        }
      }
      this.requestUpdate();
      
      this.dispatchEvent(new CustomEvent('node-toggle', {
        bubbles: true,
        composed: true,
        detail: { node, collapsed }
      }));
    } else {
      // Emit node selection event
      this.selectedId = node.id;
      this.dispatchEvent(new CustomEvent('node-select', {
        bubbles: true,
        composed: true,
        detail: { node }
      }));
    }
  }

  private _renderNodes(nodes: TreeNode[], depth: number): TemplateResult[] {
    return nodes.map(node => {
      const hasChildren = node.children && node.children.length > 0;
      const isCollapsed = this.defaultCollapsed 
        ? !this._expandedSet.has(node.id) 
        : this._collapsedSet.has(node.id);
      const isSelected = this.selectedId === node.id;
      const padLeft = `${0.4 + depth * 0.8}rem`;

      return html`
        <div class="tree-node">
          <div 
            class="tree-row ${isSelected ? 'selected' : ''}" 
            style="padding-left:${padLeft}"
            @click=${() => this._onRowClick(node)}
          >
            ${hasChildren 
              ? html`<span class="tree-chevron" @click=${(e: Event) => this._toggleCollapse(node, e)}>
                  ${this.renderIcon(isCollapsed ? 'chevron-right' : 'chevron-down')}
                </span>`
              : html`<span class="tree-spacer"></span>`}
            
            ${node.status 
              ? html`<span class="tree-dot ${node.status}"></span>`
              : (node.icon 
                  ? html`<span class="tree-icon"><r-icon name=${node.icon} size="sm"></r-icon></span>`
                  : html`<span class="tree-dot-empty"></span>`
                )}
            
            <span class="tree-label">${node.label}</span>
            
            ${node.badge !== undefined && node.badge !== null
              ? html`<span class="tree-badge">${node.badge}</span>`
              : ''}
          </div>
          ${hasChildren && !isCollapsed ? html`
            <div class="tree-children">
              ${this._renderNodes(node.children!, depth + 1)}
            </div>
          ` : ''}
        </div>
      `;
    });
  }

  override render() {
    if (!this.data || this.data.length === 0) {
      return html`<slot name="empty"></slot>`;
    }
    return html`${this._renderNodes(this.data, 0)}`;
  }
}
