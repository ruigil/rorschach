import { html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { RorschachBase } from '@rorschach/frontend/webkit/base.js';
import { store } from '@rorschach/frontend/webkit/store.js';
import { StoreController } from '@rorschach/frontend/webkit/store-controller.js';
import { openView } from '@rorschach/frontend/webkit/view-actions.js';
import type { DocsState } from './index.js';
import '@rorschach/frontend/webkit/r-panel.js';
import '@rorschach/frontend/webkit/r-button.js';
import '@rorschach/frontend/webkit/r-empty-state.js';
import '@rorschach/frontend/webkit/r-toolbar.js';

@customElement('r-doc-workspace')
export class RDocWorkspace extends RorschachBase {
  private _currentDocArtifact = new StoreController<DocsState, 'currentDocArtifact'>(this, ['docs', 'currentDocArtifact']);

  override createRenderRoot() {
    return this // Light DOM for layout styling
  }

  goHome() {
    store.namespace<DocsState>('docs').set('currentDocArtifact', 'index.html');
    openView('docs');
  }

  override render() {
    const artifact = this._currentDocArtifact.value as string | null;
    const frameUrl = artifact ? `/artifacts/${artifact}` : '';

    return html`
      <r-panel elevation="1">
        <r-toolbar slot="header-container">
          <div style="display: flex; align-items: center; gap: 8px;">
            <r-button variant="ghost" size="sm" icon="home" @click=${this.goHome}>
              Home
            </r-button>
            <span class="doc-workspace-current-path" style="color: var(--text-dim); font-size: 0.72rem; font-family: var(--font-mono);">${artifact || 'index.html'}</span>
          </div>
        </r-toolbar>
        <div class="doc-workspace-body-container" style="height: 100%; display: flex; flex-direction: column;">
          ${frameUrl ? html`
            <iframe
              src="${frameUrl}"
              class="doc-workspace-iframe"
              title="System Documentation"
              sandbox="allow-same-origin allow-scripts allow-popups"
              style="flex: 1; border: none;"
            ></iframe>
          ` : html`<r-empty-state name="file-text" text="No document loaded."></r-empty-state>`}
        </div>
      </r-panel>
    `;
  }
}
