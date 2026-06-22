import { html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { RorschachBase, ICONS } from './base.js';
import { type Topic } from './types.js';

@customElement('r-topic-list')
export class RTopicList extends RorschachBase {
  @property({ type: Array }) topics: Topic[] = [];
  @state() private _expandedTopics = new Set<string>();

  static override styles = css`
    :host {
      display: block;
    }

    .topic-entry {
      margin-bottom: 2px;
    }

    .topic-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.35rem 0.6rem;
      border-radius: 4px;
      cursor: pointer;
      font-family: var(--font-mono, monospace);
      font-size: 0.72rem;
      transition: background 0.15s;
    }

    .topic-row:hover {
      background: rgba(0, 196, 212, 0.04);
    }

    .topic-row.topic-group {
      font-weight: 600;
      color: var(--text-mid, #8abccc);
    }

    .tree-chevron {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      color: var(--text-dim, #3d6878);
    }

    .tree-spacer {
      width: 14px;
    }

    .topic-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .topic-sub-count {
      font-size: 0.64rem;
      color: var(--text-dim, #3d6878);
      opacity: 0.7;
    }

    .topic-children, .topic-subscribers {
      margin-left: 1.25rem;
      border-left: 1px solid var(--border-mid, #1a3a4a);
      padding-left: 0.5rem;
      margin-top: 2px;
      margin-bottom: 4px;
    }

    .topic-sub-row {
      font-size: 0.68rem;
      padding: 0.2rem 0;
      color: var(--text-dim, #3d6878);
    }
  `;

  private _toggleTopic(topic: string) {
    if (this._expandedTopics.has(topic)) {
      this._expandedTopics.delete(topic);
    } else {
      this._expandedTopics.add(topic);
    }
    this.requestUpdate();
  }

  private _renderEntry(t: Topic, label?: string) {
    const displayLabel = label ?? t.topic;
    const isExpanded = this._expandedTopics.has(t.topic);
    const subCount = t.subscribers.length;

    return html`
      <div class="topic-entry">
        <div class="topic-row" @click=${() => subCount > 0 && this._toggleTopic(t.topic)}>
          ${subCount > 0 
            ? html`<span class="tree-chevron">${this.renderIcon(isExpanded ? 'chevron-down' : 'chevron-right')}</span>`
            : html`<span class="tree-spacer"></span>`}
          <span class="topic-name">${displayLabel}</span>
          <span class="topic-sub-count">${subCount}</span>
        </div>
        ${isExpanded && subCount > 0 ? html`
          <div class="topic-subscribers">
            ${t.subscribers.map(s => html`
              <div class="topic-sub-row"><span class="topic-sub-name">${s}</span></div>
            `)}
          </div>
        ` : ''}
      </div>
    `;
  }

  override render() {
    if (this.topics.length === 0) {
      return html`<r-empty-state variant="panel" text="no active topics"></r-empty-state>`;
    }

    const watchTopics = this.topics.filter(t => t.topic.startsWith('$watch:'));
    const otherTopics = this.topics.filter(t => !t.topic.startsWith('$watch:'));

    const isGroupExpanded = this._expandedTopics.has('$watch');

    return html`
      ${watchTopics.length > 0 ? html`
        <div class="topic-entry">
          <div class="topic-row topic-group" @click=${() => this._toggleTopic('$watch')}>
            <span class="tree-chevron">${this.renderIcon(isGroupExpanded ? 'chevron-down' : 'chevron-right')}</span>
            <span class="topic-name">$watch</span>
            <span class="topic-sub-count">${watchTopics.length}</span>
          </div>
          ${isGroupExpanded ? html`
            <div class="topic-children">
              ${watchTopics.map(t => this._renderEntry(t, t.topic.slice('$watch:'.length)))}
            </div>
          ` : ''}
        </div>
      ` : ''}
      ${otherTopics.map(t => this._renderEntry(t))}
    `;
  }
}
