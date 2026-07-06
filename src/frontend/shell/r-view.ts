import {
  customElement,
  html,
  property,
  RorschachBase,
  StoreController
} from '@rorschach/webkit';

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
    const cfg = pluginHost().getViewConfig(this.viewId);
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
    const contentEl = this._getContentElement();
    if (!view || !view.isOpen) return html``;

    return html`${contentEl}`;
  }
}
