import { html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import './r-list.js';
import type { ListItem } from './r-list.js';

export type KVItem = {
  key: string;
  value: string;
};

@customElement('r-kv-list')
export class RKvList extends RorschachBase {
  @property({ type: Array }) items: KVItem[] = [];
  @property({ type: String }) emptyText = 'none';

  override render() {
    const listItems: ListItem[] = this.items.map(item => ({
      id: item.key,
      label: item.key,
      meta: item.value,
    }));

    return html`
      <r-list 
        variant="flat"
        .items=${listItems}
        .emptyText=${this.emptyText}
      ></r-list>
    `;
  }
}
