import { html } from 'lit'
import { customElement } from 'lit/decorators.js'
import { RorschachBase } from '@rorschach/frontend/webkit/base.js'
import { StoreController } from '@rorschach/frontend/webkit/store-controller.js'
import { store } from '@rorschach/frontend/webkit/store.js'
import type { NotebookState } from './index.js'
import '@rorschach/frontend/webkit/r-panel.js'
import '@rorschach/frontend/webkit/r-tabs.js'
import '@rorschach/frontend/webkit/r-toolbar.js'

import './r-notebook-todos.js'
import './r-notebook-journal.js'
import './r-notebook-tracker.js'

@customElement('r-notebook-workspace')
export class RNotebookWorkspace extends RorschachBase {
  private _activeTab = new StoreController<NotebookState, 'activeTab'>(this, ['notebook', 'activeTab'])

  override createRenderRoot() {
    return this // Light DOM
  }

  private _selectTab(tab: 'todos' | 'journal' | 'tracker') {
    store.namespace<NotebookState>('notebook').set('activeTab', tab)
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
            <button ?active=${active === 'todos'} data-tab="todos">
              <r-icon name="file-text" size="sm" style="margin-right: 6px;"></r-icon>
              <span>Todos</span>
            </button>
            <button ?active=${active === 'journal'} data-tab="journal">
              <r-icon name="file" size="sm" style="margin-right: 6px;"></r-icon>
              <span>Journal</span>
            </button>
            <button ?active=${active === 'tracker'} data-tab="tracker">
              <r-icon name="activity" size="sm" style="margin-right: 6px;"></r-icon>
              <span>Tracker</span>
            </button>
          </r-tabs>
        </r-toolbar>

        <!-- Panel Active Content Body -->
        <div class="nb-workspace-body">
          ${active === 'todos' ? html`<r-notebook-todos class="nb-full-height"></r-notebook-todos>` : ''}
          ${active === 'journal' ? html`<r-notebook-journal class="nb-full-height"></r-notebook-journal>` : ''}
          ${active === 'tracker' ? html`<r-notebook-tracker class="nb-full-height"></r-notebook-tracker>` : ''}
        </div>
      </r-panel>
    `
  }
}
