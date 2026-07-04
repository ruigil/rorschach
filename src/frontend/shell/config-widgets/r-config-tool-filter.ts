import {
  customElement,
  html,
  property,
  RorschachBase,
  state
} from '@rorschach/webkit';

import type { ConfigFieldChangeEvent } from './r-config-field.js';
import { childConfigKey } from './path-utils.js';

type FilterType = 'allow' | 'deny';

@customElement('r-config-tool-filter')
export class RConfigToolFilter extends RorschachBase {
  @property({ type: String }) sectionId = '';
  @property({ type: String }) configKey = '';
  @property({ type: String }) key = '';
  @property({ type: String }) label = '';
  @property({ type: String }) hint = '';
  @property({ type: Object }) value: any = undefined;

  @state() private _filterType: FilterType = 'allow';

  override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    if (this.value && typeof this.value === 'object') {
      this._filterType = 'deny' in this.value ? 'deny' : 'allow';
    }
  }

  private _emit(value: any) {
    this.dispatchEvent(new CustomEvent('config-field-change', {
      bubbles: true,
      composed: true,
      detail: { sectionId: this.sectionId, configKey: this.configKey, key: this.key, value },
    }) as ConfigFieldChangeEvent);
  }

  private _emitArray(items: string[]) {
    this._emit({ [this._filterType]: items });
  }

  override render() {
    const arrayVal = (this.value && typeof this.value === 'object')
      ? (this.value[this._filterType] ?? [])
      : [];
    const displayVal = Array.isArray(arrayVal) ? arrayVal.join(', ') : '';
    const nextConfigKey = childConfigKey(this.configKey, this.key);

    return html`
      <div class="tool-filter-container" style="display: flex; gap: 8px; align-items: center;">
        <r-select
          style="flex-shrink: 0; width: auto;"
          .value=${this._filterType}
          .options=${[
            { value: 'allow', label: 'Allow only' },
            { value: 'deny', label: 'Deny only' },
          ]}
          @change=${(e: CustomEvent<{ value: string }>) => {
            this._filterType = e.detail.value as FilterType;
          }}
        ></r-select>
        <r-input
          type="text"
          .value=${displayVal}
          .label=${this.label}
          .hint=${this.hint}
          .name=${this._filterType}
          placeholder="e.g. tool_name_1, tool_name_2"
          @change=${(e: CustomEvent<{ value: string | number }>) => {
            const items = String(e.detail.value).split(',').map(s => s.trim()).filter(Boolean);
            this._emitArray(items);
          }}
        ></r-input>
      </div>
    `;
  }
}
