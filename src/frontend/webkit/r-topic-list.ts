import { customElement, html, property, RorschachBase } from './base.js';

import type { Topic } from './types.js';
import './r-tree.js';
import type { TreeNode } from './r-tree.js';

@customElement('r-topic-list')
export class RTopicList extends RorschachBase {
  @property({ type: Array }) topics: Topic[] = [];

  override render() {
    if (this.topics.length === 0) {
      return html`<r-empty-state variant="panel" text="no active topics"></r-empty-state>`;
    }

    const watchTopics = this.topics.filter(t => t.topic.startsWith('$watch:'));
    const otherTopics = this.topics.filter(t => !t.topic.startsWith('$watch:'));

    const nodes: TreeNode[] = [];

    // Group watch topics under a single root node
    if (watchTopics.length > 0) {
      nodes.push({
        id: '$watch',
        label: '$watch',
        badge: watchTopics.length,
        children: watchTopics.map(t => ({
          id: t.topic,
          label: t.topic.slice('$watch:'.length),
          badge: t.subscribers.length,
          children: t.subscribers.map(s => ({
            id: `${t.topic}-sub-${s}`,
            label: s,
            icon: 'eye',
          })),
        })),
      });
    }

    // Add other topics
    otherTopics.forEach(t => {
      nodes.push({
        id: t.topic,
        label: t.topic,
        badge: t.subscribers.length,
        children: t.subscribers.map(s => ({
          id: `${t.topic}-sub-${s}`,
          label: s,
          icon: 'eye',
        })),
      });
    });

    return html`
      <r-tree .data=${nodes} ?defaultCollapsed=${true}></r-tree>
    `;
  }
}
