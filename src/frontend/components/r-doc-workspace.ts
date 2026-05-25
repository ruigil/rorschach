import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { store, StoreController } from '../store.js';
import { openWindow } from '../actions.js';

@customElement('r-doc-workspace')
export class RDocWorkspace extends RorschachBase {
  private _currentDocArtifact = new StoreController(this, 'currentDocArtifact');

  override createRenderRoot() {
    return this; // Light DOM for layout styling
  }

  goHome() {
    store.set('currentDocArtifact', 'index.html');
    localStorage.setItem('rorschach.docWorkspaceArtifact', 'index.html');
    openWindow('docs', { currentDocArtifact: 'index.html' });
  }

  override render() {
    const artifact = this._currentDocArtifact.value as string | null;
    const frameUrl = artifact ? `/artifacts/${artifact}` : '';

    return html`
      <div class="doc-workspace-content-root">
        <div class="doc-workspace-toolbar">
          <button class="doc-workspace-home-btn" @click=${this.goHome}>
            ${this.renderIcon('home')}
            <span>Home</span>
          </button>
          <span class="doc-workspace-current-path">${artifact || 'index.html'}</span>
        </div>
        <div class="doc-workspace-body-container">
          ${frameUrl ? html`
            <iframe
              src="${frameUrl}"
              class="doc-workspace-iframe"
              title="System Documentation"
              sandbox="allow-same-origin allow-scripts allow-popups"
            ></iframe>
          ` : html`<div class="doc-workspace-empty"><span>no document loaded</span></div>`}
        </div>
      </div>
    `;
  }
}
