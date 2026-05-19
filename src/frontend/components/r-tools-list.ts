import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { RorschachBase } from './base.js';

@customElement('r-tools-list')
export class RToolsList extends RorschachBase {
  @state() private _toolsMap: Record<string, any> = {};

  // Render to light DOM to reuse shell/observe styles
  override createRenderRoot() {
    return this;
  }

  register(name: string, schema: any) {
    this._toolsMap = { ...this._toolsMap, [name]: schema };
  }

  unregister(name: string) {
    const next = { ...this._toolsMap };
    delete next[name];
    this._toolsMap = next;
  }

  override render() {
    const names = Object.keys(this._toolsMap).sort();

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
        const desc = this._toolsMap[name]?.function?.description ?? '';
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
