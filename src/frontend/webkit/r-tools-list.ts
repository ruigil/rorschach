import { html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { StoreController } from './store-controller.js';
import './r-list.js';
import type { ListItem } from './r-list.js';

type ToolSchema = { type: 'function'; function: { name: string; description: string; parameters: object } }

type ShellToolsState = {
  tools: Record<string, ToolSchema>
};

@customElement('r-tools-list')
export class RToolsList extends RorschachBase {
  private _tools = new StoreController<ShellToolsState, 'tools'>(this, ['shell', 'tools']);

  override render() {
    const toolsMap = this._tools.value || {};
    const listItems: ListItem[] = Object.keys(toolsMap).sort().map(name => ({
      id: name,
      label: name,
      description: toolsMap[name]?.function?.description ?? '',
      icon: 'wrench'
    }));

    return html`
      <r-list 
        .items=${listItems}
        emptyText="no tools registered"
      ></r-list>
    `;
  }
}
