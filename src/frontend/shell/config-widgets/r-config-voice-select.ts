import { customElement, html, property, RorschachBase } from '@rorschach/webkit';

import type { ConfigFieldChangeEvent, ConfigFieldSchema } from './r-config-field.js';

@customElement('r-config-voice-select')
export class RConfigVoiceSelect extends RorschachBase {
  @property({ type: String }) sectionId = '';
  @property({ type: String }) configKey = '';
  @property({ type: String }) key = '';
  @property({ type: String }) label = '';
  @property({ type: String }) hint = '';
  @property({ type: String }) value = '';
  @property({ type: Array }) models: string[] = [];
  @property({ type: Object }) pluginValues: Record<string, any> = {};
  @property({ type: Object }) schema: ConfigFieldSchema = {};

  override createRenderRoot() { return this; }

  private _emit(value: string) {
    this.dispatchEvent(new CustomEvent('config-field-change', {
      bubbles: true,
      composed: true,
      detail: { sectionId: this.sectionId, configKey: this.configKey, key: this.key, value },
    }) as ConfigFieldChangeEvent);
  }

  override render() {
    // Resolve the dependent ttsModel field from the plugin's current values.
    let target = this.pluginValues;
    if (this.configKey) {
      for (const part of this.configKey.split('.')) {
        target = target?.[part] ?? {}
      }
    }
    const selectedTtsModel = target.ttsModel || target.model || '';

    let modelVoices: string[] = [];
    if (selectedTtsModel) {
      const entry = this.models.find(m => m.startsWith(selectedTtsModel + '|'));
      if (entry) {
        const parts = entry.split('|');
        if (parts[2]) modelVoices = parts[2].split(',').filter(Boolean);
      }
    }
    if (modelVoices.length === 0) {
      modelVoices = this.schema.enum ?? ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
    }

    return html`
      <r-select
        .value=${this.value}
        .label=${this.label}
        .hint=${this.hint}
        .options=${modelVoices.map((v: string) => ({ value: v, label: v }))}
        @change=${(e: CustomEvent<{ value: string }>) => this._emit(e.detail.value)}
      ></r-select>
    `;
  }
}
