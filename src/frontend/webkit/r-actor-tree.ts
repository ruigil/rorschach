import { html, css, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import type { Actor } from './types.js';
import './r-tree.js';
import type { TreeNode } from './r-tree.js';

@customElement('r-actor-tree')
export class RActorTree extends RorschachBase {
  @property({ type: Array }) actors: Actor[] = [];
  @state() private _selectedActor: string | null = null;

  private _actorsMap: Record<string, Actor> = {};

  static override styles = css`
    :host {
      display: block;
      flex: 1;
      overflow-y: auto;
      padding: 0.4rem 0;
    }
    :host::-webkit-scrollbar { width: 3px; }
    :host::-webkit-scrollbar-track { background: transparent; }
    :host::-webkit-scrollbar-thumb { background: var(--border-mid); border-radius: 2px; }
  `;

  override willUpdate(changedProperties: Map<string, any>) {
    if (changedProperties.has('actors')) {
      this._actorsMap = {};
      this.actors.forEach(a => {
        this._actorsMap[a.name] = a;
      });
      if (this._selectedActor && !this._actorsMap[this._selectedActor]) {
        this._selectedActor = null;
      }
    }
  }

  private _buildTree(actors: Actor[]): TreeNode<Actor>[] {
    const nodes: Record<string, TreeNode<Actor>> = {};
    
    actors.forEach(a => {
      const parts = a.name.split('/');
      parts.forEach((_, i) => {
        const path = parts.slice(0, i + 1).join('/');
        const label = parts[i]!;
        if (!nodes[path]) {
          nodes[path] = { id: path, label, children: [], data: undefined };
        }
      });
      
      const node = nodes[a.name]!;
      node.data = a;
      node.status = a.status || 'running';
      node.badge = a.messagesProcessed ?? 0;
    });

    const roots: TreeNode<Actor>[] = [];
    Object.values(nodes).forEach(node => {
      const parts = node.id.split('/');
      if (parts.length === 1) {
        roots.push(node);
      } else {
        const parentPath = parts.slice(0, -1).join('/');
        if (nodes[parentPath]) {
          nodes[parentPath]!.children!.push(node);
        } else {
          roots.push(node);
        }
      }
    });

    // Make sure folder nodes without data get styled/treated correctly
    Object.values(nodes).forEach(node => {
      const hasChildren = node.children && node.children.length > 0;
      if (hasChildren && !node.data) {
        node.status = undefined; // Folder status is handled by children or neutral
        node.badge = undefined;
      }
    });

    const sort = (arr: TreeNode<Actor>[]) => {
      arr.sort((a, b) => a.label.localeCompare(b.label));
      arr.forEach(n => {
        if (n.children) sort(n.children);
      });
      return arr;
    };
    
    return sort(roots);
  }

  private _onNodeSelect(e: CustomEvent<{ node: TreeNode<Actor> }>) {
    const node = e.detail.node;
    if (node.data) {
      this._selectedActor = node.id;
      this.dispatchEvent(new CustomEvent('actor-select', {
        bubbles: true,
        composed: true,
        detail: { actor: node.data },
      }));
    }
  }

  override render() {
    const roots = this._buildTree(Object.values(this._actorsMap));
    if (roots.length === 0) {
      return html`<r-empty-state variant="panel" name="monitor" text="awaiting metrics snapshot"></r-empty-state>`;
    }
    return html`
      <r-tree 
        .data=${roots} 
        .selectedId=${this._selectedActor}
        @node-select=${this._onNodeSelect}
      ></r-tree>
    `;
  }
}
