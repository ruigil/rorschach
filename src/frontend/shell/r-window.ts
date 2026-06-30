import { html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase } from '@rorschach/frontend/webkit/base.js';
import { StoreController } from '@rorschach/frontend/webkit/store-controller.js';
import type { ShellState } from '../types/state.js';
import { pluginHost } from './plugin-host.js';

@customElement('r-window')
export class RWindow extends RorschachBase {
  @property({ type: String }) windowId!: string;

  private _windows = new StoreController<ShellState, 'windows'>(this, ['shell', 'windows']);
  private _cachedContentElements = new Map<string, HTMLElement>();

  override createRenderRoot() {
    return this; // Light DOM for direct styling inclusion
  }

  get config() {
    return this._windows.value[this.windowId];
  }

  private _getContentElement() {
    const cfg = pluginHost.windowRegistry.get(this.windowId);
    if (!cfg) return null;

    let el = this._cachedContentElements.get(this.windowId);
    if (!el) {
      el = document.createElement(cfg.contentTag);
      (el as any).windowId = this.windowId;
      this._cachedContentElements.set(this.windowId, el);
    }
    return el;
  }

  override render() {
    const win = this.config;
    if (!win || !win.isOpen) return html``;

    const contentEl = this._getContentElement();

    return html`
      <div class="r-window-chrome" style="width: 100%; height: 100%; display: flex; flex-direction: column;">
        <div class="r-window-body" style="flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0;">
          ${contentEl}
        </div>
      </div>
    `;
  }
}
