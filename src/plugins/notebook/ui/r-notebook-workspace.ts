import { html } from 'lit'
import { customElement } from 'lit/decorators.js'
import { RorschachBase } from '@rorschach/frontend/webkit/base.js'
import { StoreController } from '@rorschach/frontend/webkit/store-controller.js'
import { store } from '@rorschach/frontend/webkit/store.js'
import type { NotebookState } from './index.js'

import './r-notebook-calendar.js'
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
      <div class="r-window-chrome nb-workspace-frame">
        <!-- Panel Tabs Header -->
        <div class="nb-tabs-header">
          <button class="nb-tab-btn ${active === 'todos' ? 'active' : ''}" @click=${() => this._selectTab('todos')}>
            <r-icon name="file-text" style="width: 14px; height: 14px; margin-right: 6px;"></r-icon>
            <span>Todos</span>
          </button>
          <button class="nb-tab-btn ${active === 'journal' ? 'active' : ''}" @click=${() => this._selectTab('journal')}>
            <r-icon name="file" style="width: 14px; height: 14px; margin-right: 6px;"></r-icon>
            <span>Journal</span>
          </button>
          <button class="nb-tab-btn ${active === 'tracker' ? 'active' : ''}" @click=${() => this._selectTab('tracker')}>
            <r-icon name="activity" style="width: 14px; height: 14px; margin-right: 6px;"></r-icon>
            <span>Tracker</span>
          </button>
        </div>

        <!-- Panel Active Content Body -->
        <div class="r-window-body nb-workspace-body">
          ${active === 'todos' ? html`<r-notebook-todos class="nb-full-height"></r-notebook-todos>` : ''}
          ${active === 'journal' ? html`<r-notebook-journal class="nb-full-height"></r-notebook-journal>` : ''}
          ${active === 'tracker' ? html`<r-notebook-tracker class="nb-full-height"></r-notebook-tracker>` : ''}
        </div>
      </div>
    `
  }
}
