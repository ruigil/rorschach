import { html, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import type { Actor } from './types.js';

type ActorNode = {
  label: string;
  path: string;
  children: ActorNode[];
  data: Actor | null;
};

@customElement('r-actor-tree')
export class RActorTree extends RorschachBase {
  @property({ type: Array }) actors: Actor[] = [];
  @state() private _selectedActor: string | null = null;
  @state() private _collapsedSet = new Set<string>();

  private _actorsMap: Record<string, Actor> = {};

  // Render to light DOM to reuse shell/observe styles
  override createRenderRoot() {
    return this;
  }

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

  private _buildTree(actors: Actor[]): ActorNode[] {
    const nodes: Record<string, ActorNode> = {};
    actors.forEach(a => {
      const parts = a.name.split('/');
      parts.forEach((_, i) => {
        const path = parts.slice(0, i + 1).join('/');
        const label = parts[i]!;
        if (!nodes[path]) {
          nodes[path] = { label, path, children: [], data: null };
        }
      });
      nodes[a.name]!.data = a;
    });

    const roots: ActorNode[] = [];
    Object.values(nodes).forEach(node => {
      const parts = node.path.split('/');
      if (parts.length === 1) {
        roots.push(node);
      } else {
        const parentPath = parts.slice(0, -1).join('/');
        if (nodes[parentPath]) {
          nodes[parentPath]!.children.push(node);
        } else {
          roots.push(node);
        }
      }
    });

    const sort = (arr: ActorNode[]) => {
      arr.sort((a, b) => a.label.localeCompare(b.label));
      arr.forEach(n => sort(n.children));
      return arr;
    };
    return sort(roots);
  }

  private _renderNodes(nodes: ActorNode[], depth: number): TemplateResult[] {
    return nodes.map(node => {
      const hasChildren = node.children.length > 0;
      const isCollapsed = this._collapsedSet.has(node.path);
      const isSelected = this._selectedActor === node.path;
      const status = node.data?.status || (hasChildren && !node.data ? null : 'running');
      const padLeft = `${0.6 + depth * 1.1}rem`;

      const handleChevronClick = (e: Event) => {
        e.stopPropagation();
        if (this._collapsedSet.has(node.path)) {
          this._collapsedSet.delete(node.path);
        } else {
          this._collapsedSet.add(node.path);
        }
        this.requestUpdate();
      };

      const handleRowClick = () => {
        if (node.data) {
          this._selectedActor = node.path;
          this.dispatchEvent(new CustomEvent('actor-select', {
            bubbles: true,
            composed: true,
            detail: { actor: node.data },
          }));
        } else {
          if (this._collapsedSet.has(node.path)) {
            this._collapsedSet.delete(node.path);
          } else {
            this._collapsedSet.add(node.path);
          }
          this.requestUpdate();
        }
      };

      return html`
        <div class="tree-node">
          <div 
            class="tree-row ${isSelected ? 'selected' : ''}" 
            style="padding-left:${padLeft}"
            @click=${handleRowClick}
          >
            ${hasChildren 
              ? html`<span class="tree-chevron" @click=${handleChevronClick}>
                  ${this.renderIcon(isCollapsed ? 'chevron-right' : 'chevron-down')}
                </span>`
              : html`<span class="tree-spacer"></span>`}
            
            ${status 
              ? html`<span class="tree-dot ${status}"></span>`
              : html`<span class="tree-dot-empty"></span>`}
            
            <span class="tree-label">${node.label}</span>
            
            ${node.data ? html`<span class="tree-msg-count">${node.data.messagesProcessed ?? 0}</span>` : ''}
          </div>
          ${hasChildren && !isCollapsed ? html`
            <div class="tree-children">
              ${this._renderNodes(node.children, depth + 1)}
            </div>
          ` : ''}
        </div>
      `;
    });
  }

  updateActors(actors: Actor[]) {
    this.actors = actors;
    return this._selectedActor ? this._actorsMap[this._selectedActor] : null;
  }

  override render() {
    const roots = this._buildTree(Object.values(this._actorsMap));
    if (roots.length === 0) {
      return html`<r-empty-state variant="panel" name="monitor" text="awaiting metrics snapshot"></r-empty-state>`;
    }
    return html`${this._renderNodes(roots, 0)}`;
  }
}
