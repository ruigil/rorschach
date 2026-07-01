import { html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase } from '@rorschach/frontend/webkit/base.js';
import { StoreController } from '@rorschach/frontend/webkit/store-controller.js';
import type { ShellState } from '../types/state.js';
import { pluginHost } from './plugin-host.js';

@customElement('r-view')
export class RView extends RorschachBase {
  @property({ type: String }) viewId!: string;

  private _views = new StoreController(this, ['shell', 'views']);
  private _cachedContentElements = new Map<string, HTMLElement>();

  override createRenderRoot() {
    return this; // Light DOM for direct styling inclusion
  }

  get config() {
    return this._views.value[this.viewId];
  }

  private _getContentElement() {
    const cfg = pluginHost.viewRegistry.get(this.viewId);
    if (!cfg) return null;

    let el = this._cachedContentElements.get(this.viewId);
    if (!el) {
      el = document.createElement(cfg.contentTag);
      (el as any).viewId = this.viewId;
      this._cachedContentElements.set(this.viewId, el);
    }
    return el;
  }

  override render() {
    const view = this.config;
    if (!view || !view.isOpen) return html``;

    const contentEl = this._getContentElement();

    return html`${contentEl}`;
  }
}
