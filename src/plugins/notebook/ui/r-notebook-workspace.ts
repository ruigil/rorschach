import {
  css,
  customElement,
  html,
  RorschachBase,
  store,
  StoreController
} from '@rorschach/webkit';
import type { NotebookState } from './index.js'

import './r-notebook-todos.js'
import './r-notebook-journal.js'
import './r-notebook-tracker.js'

@customElement('r-notebook-workspace')
export class RNotebookWorkspace extends RorschachBase {
  private _activeTab = new StoreController(this, ['notebook', 'activeTab'])

  static override styles = css`
    :host {
      display: block;
      height: 100%;
      width: 100%;
    }
  `;

  private _selectTab(tab: 'todos' | 'journal' | 'tracker') {
    store.namespace('notebook').set('activeTab', tab)
  }

  override render() {
    const active = this._activeTab.value as 'todos' | 'journal' | 'tracker'

    return html`
      <r-panel elevation="1">
        <!-- Panel Tabs Header -->
        <r-toolbar slot="header-container">
          <r-tabs 
            @tab-change=${(e: CustomEvent) => this._selectTab(e.detail.tab as any)}
          >
            <button ?active=${active === 'journal'} data-tab="journal">
              <r-icon name="file" size="sm" style="margin-right: 6px;"></r-icon>
              <span>Journal</span>
            </button>
            <button ?active=${active === 'todos'} data-tab="todos">
              <r-icon name="file-text" size="sm" style="margin-right: 6px;"></r-icon>
              <span>Todos</span>
            </button>
            <button ?active=${active === 'tracker'} data-tab="tracker">
              <r-icon name="activity" size="sm" style="margin-right: 6px;"></r-icon>
              <span>Tracker</span>
            </button>
          </r-tabs>
        </r-toolbar>

        <!-- Panel Active Content Body -->
        <div class="nb-workspace-body" style="height: 100%; display: flex; flex-direction: column;">
          ${active === 'journal' ? html`<r-notebook-journal style="height: 100%; display: flex; flex-direction: column; min-height: 0;"></r-notebook-journal>` : ''}
          ${active === 'tracker' ? html`<r-notebook-tracker style="height: 100%; display: flex; flex-direction: column; min-height: 0;"></r-notebook-tracker>` : ''}
          ${active === 'todos' ? html`<r-notebook-todos style="height: 100%; display: flex; flex-direction: column; min-height: 0;"></r-notebook-todos>` : ''}
        </div>
      </r-panel>
    `
  }
}
