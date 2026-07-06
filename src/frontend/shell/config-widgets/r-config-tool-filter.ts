import {
  customElement,
  html,
  property,
  RorschachBase
} from '@rorschach/webkit';

import type { ConfigFieldChangeEvent } from './r-config-field.js';

@customElement('r-config-tool-filter')
export class RConfigToolFilter extends RorschachBase {
  @property({ type: String }) sectionId = '';
  @property({ type: String }) configKey = '';
  @property({ type: String }) key = '';
  @property({ type: String }) label = '';
  @property({ type: String }) hint = '';
  @property({ type: Object }) value: any = undefined;

  override createRenderRoot() { return this; }

  private _emit(value: any) {
    this.dispatchEvent(new CustomEvent('config-field-change', {
      bubbles: true,
      composed: true,
      detail: { sectionId: this.sectionId, configKey: this.configKey, key: this.key, value },
    }) as ConfigFieldChangeEvent);
  }

  override render() {
    const allowVal = (this.value && typeof this.value === 'object')
      ? (this.value['allow'] ?? [])
      : [];
    const denyVal = (this.value && typeof this.value === 'object')
      ? (this.value['deny'] ?? [])
      : [];

    const displayAllowVal = Array.isArray(allowVal) ? allowVal.join(', ') : '';
    const displayDenyVal = Array.isArray(denyVal) ? denyVal.join(', ') : '';

    return html`
      <div class="tool-filter-container" style="display: flex; flex-direction: column; gap: 8px; width: 100%;">
        <r-input
          type="text"
          .value=${displayAllowVal}
          label="Allow only"
          .hint=${this.hint ? `${this.hint} (allowed tools)` : 'Comma-separated list of allowed tools'}
          name="allow"
          placeholder="e.g. tool_name_1, tool_name_2"
          @change=${(e: CustomEvent<{ value: string | number }>) => {
            const items = String(e.detail.value).split(',').map(s => s.trim()).filter(Boolean);
            const currentDeny = (this.value && typeof this.value === 'object') ? (this.value.deny ?? []) : [];
            const newValue: Record<string, string[]> = {};
            if (items.length > 0) {
              newValue.allow = items;
            }
            if (currentDeny.length > 0) {
              newValue.deny = currentDeny;
            }
            this._emit(newValue);
          }}
        ></r-input>
        <r-input
          type="text"
          .value=${displayDenyVal}
          label="Deny only"
          .hint=${this.hint ? `${this.hint} (denied tools)` : 'Comma-separated list of denied tools'}
          name="deny"
          placeholder="e.g. tool_name_1, tool_name_2"
          @change=${(e: CustomEvent<{ value: string | number }>) => {
            const items = String(e.detail.value).split(',').map(s => s.trim()).filter(Boolean);
            const currentAllow = (this.value && typeof this.value === 'object') ? (this.value.allow ?? []) : [];
            const newValue: Record<string, string[]> = {};
            if (currentAllow.length > 0) {
              newValue.allow = currentAllow;
            }
            if (items.length > 0) {
              newValue.deny = items;
            }
            this._emit(newValue);
          }}
        ></r-input>
      </div>
    `;
  }
}

