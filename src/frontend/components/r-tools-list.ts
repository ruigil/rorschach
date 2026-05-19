import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { StoreController } from '../store.js';

@customElement('r-tools-list')
export class RToolsList extends RorschachBase {
  private _tools = new StoreController(this, 'tools');

  // Render to light DOM to reuse shell/observe styles
  override createRenderRoot() {
    return this;
  }

  override render() {
    const toolsMap = this._tools.value;
    const names = Object.keys(toolsMap).sort();

    if (names.length === 0) {
      return html`
        <r-empty-state 
          variant="panel" 
          name="wrench" 
          text="no tools registered"
        ></r-empty-state>
      `;
    }

    return html`
      ${names.map(name => {
        const desc = toolsMap[name]?.function?.description ?? '';
        return html`
          <div class="tool-row">
            <span class="tool-name">${name}</span>
            <span class="tool-desc">${desc}</span>
          </div>
        `;
      })}
    `;
  }
}
