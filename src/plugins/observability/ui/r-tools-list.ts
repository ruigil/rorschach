import { customElement, html, RorschachBase, StoreController, send } from '@rorschach/webkit';
import type { ListItem } from '@rorschach/webkit';

type ToolSchema = { type: 'function'; function: { name: string; description: string; parameters: object } }

@customElement('r-tools-list')
export class RToolsList extends RorschachBase {
  private _tools = new StoreController(this, ['observe', 'tools']);

  override connectedCallback() {
    super.connectedCallback();
    send({ type: 'tools.list.request' });
  }

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
