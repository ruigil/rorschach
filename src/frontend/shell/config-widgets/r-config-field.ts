import {
  customElement,
  html,
  nothing,
  property,
  RorschachBase,
  type RInputType,
  type TemplateResult
} from '@rorschach/webkit';

import './r-config-voice-select.js';
import './r-config-tool-filter.js';
import './r-config-google-account.js';

export type ConfigFieldSchema = {
  type?: string;
  enum?: string[];
  default?: any;
  description?: string;
  properties?: Record<string, ConfigFieldSchema>;
  oneOf?: any[];
  minimum?: number;
  maximum?: number;
  'x-ui'?: {
    widget?: string;
    secret?: boolean;
    label?: string;
    rows?: number;
  };
};

export type ConfigFieldChangeEvent = CustomEvent<{
  sectionId: string;
  configKey: string;
  key: string;
  value: any;
}>;

const inferWidget = (schema: ConfigFieldSchema): string => {
  if (schema.oneOf && schema.oneOf.some(s => s.properties && ('allow' in s.properties || 'deny' in s.properties))) {
    return 'tool-filter';
  }
  if (schema.type === 'object') return 'object';
  if (schema.type === 'boolean') return 'toggle';
  if (schema.type === 'number') return 'number';
  if (schema.enum) return 'select';
  return 'text';
};

@customElement('r-config-field')
export class RConfigField extends RorschachBase {
  @property({ type: String }) sectionId = '';
  @property({ type: String }) configKey = '';
  @property({ type: String }) key = '';
  @property({ type: Object }) schema: ConfigFieldSchema = {};
  @property({ type: Object }) value: any = undefined;
  /** Models list for model-select widget: entries formatted as `id|name|voices`. */
  @property({ type: Array }) models: string[] = [];
  /** All current values for the plugin (used by voice-select to resolve
   *  the dependent ttsModel field). */
  @property({ type: Object }) pluginValues: Record<string, any> = {};

  override createRenderRoot() {
    return this; // Light DOM — uses global config.css field layout
  }

  private _emit(value: any) {
    this.dispatchEvent(new CustomEvent('config-field-change', {
      bubbles: true,
      composed: true,
      detail: { sectionId: this.sectionId, configKey: this.configKey, key: this.key, value },
    }) as ConfigFieldChangeEvent);
  }

  override render() {
    const widget = this.schema['x-ui']?.widget ?? inferWidget(this.schema);
    const label = this.schema['x-ui']?.label ?? this.key;
    const hint = this.schema.description ?? '';
    const resolvedValue = this.value ?? this.schema.default ?? '';

    let fieldContent: TemplateResult;

    if (widget === 'toggle') {
      fieldContent = html`
        <r-toggle
          .checked=${!!resolvedValue}
          .label=${label}
          .hint=${hint}
          @change=${(e: CustomEvent<{ checked: boolean }>) => this._emit(e.detail.checked)}
        ></r-toggle>`;
    } else if (widget === 'select') {
      fieldContent = html`
        <r-select
          variant="field"
          .value=${String(resolvedValue)}
          .label=${label}
          .hint=${hint}
          .options=${(this.schema.enum ?? []).map((v: string) => ({ value: v, label: v }))}
          @change=${(e: CustomEvent<{ value: string }>) => this._emit(e.detail.value)}
        ></r-select>`;
    } else if (widget === 'voice-select') {
      fieldContent = html`
        <r-config-voice-select
          .sectionId=${this.sectionId}
          .configKey=${this.configKey}
          .key=${this.key}
          .label=${label}
          .hint=${hint}
          .value=${resolvedValue}
          .models=${this.models}
          .pluginValues=${this.pluginValues}
          .schema=${this.schema}
          @config-field-change=${(e: ConfigFieldChangeEvent) => this._emit(e.detail.value)}
        ></r-config-voice-select>`;
    } else if (widget === 'model-select') {
      fieldContent = html`
        <r-search-select
          .value=${String(resolvedValue)}
          .label=${label}
          .hint=${hint}
          .name=${this.key}
          .placeholder="Select model..."
          .options=${this.models.map(m => {
            const parts = m.split('|');
            return { value: parts[0]!, label: parts[1] || parts[0]!, sublabel: parts[0]! };
          })}
          @change=${(e: CustomEvent<{ value: string }>) => this._emit(e.detail.value)}
        ></r-search-select>`;
    } else if (widget === 'tool-filter') {
      fieldContent = html`
        <r-config-tool-filter
          .sectionId=${this.sectionId}
          .configKey=${this.configKey}
          .key=${this.key}
          .label=${label}
          .hint=${hint}
          .value=${resolvedValue}
          @config-field-change=${(e: ConfigFieldChangeEvent) => this._emit(e.detail.value)}
        ></r-config-tool-filter>`;
    } else if (widget === 'textarea') {
      fieldContent = html`
        <r-input
          type="textarea"
          .value=${resolvedValue}
          .label=${label}
          .hint=${hint}
          .name=${this.key}
          .rows=${this.schema['x-ui']?.rows ?? 3}
          @change=${(e: CustomEvent<{ value: string | number }>) => this._emit(e.detail.value)}
        ></r-input>`;
    } else if (widget === 'object') {
      const subProps = this.schema.properties ?? {};
      const nextConfigKey = this.configKey ? `${this.configKey}.${this.key}` : this.key;
      fieldContent = html`
        <div class="nested-object-label">${label}</div>
        <div class="nested-object-fields">
          ${Object.entries(subProps).map(([subKey, subSchema]: [string, ConfigFieldSchema]) =>
            html`<r-config-field
              .sectionId=${this.sectionId}
              .configKey=${nextConfigKey}
              .key=${subKey}
              .schema=${subSchema}
              .value=${(typeof resolvedValue === 'object' && resolvedValue !== null) ? resolvedValue[subKey] : undefined}
              .models=${this.models}
              .pluginValues=${this.pluginValues}
              @config-field-change=${(e: ConfigFieldChangeEvent) => {
                e.stopPropagation();
                this.dispatchEvent(new CustomEvent('config-field-change', {
                  bubbles: true,
                  composed: true,
                  detail: { sectionId: e.detail.sectionId, configKey: e.detail.configKey, key: e.detail.key, value: e.detail.value },
                }) as ConfigFieldChangeEvent);
              }}
            ></r-config-field>`
          )}
        </div>`;
    } else if (widget === 'google-account') {
      fieldContent = html`<r-config-google-account></r-config-google-account>`;
    } else {
      const secret = this.schema['x-ui']?.secret ?? false;
      const inputType = secret ? 'password' : widget === 'number' ? 'number' : 'text';
      fieldContent = html`
        <r-input
          type=${inputType as RInputType}
          .value=${resolvedValue}
          .label=${label}
          .hint=${hint}
          .name=${this.key}
          .placeholder=${String(this.schema.default ?? '')}
          .min=${this.schema.minimum}
          .max=${this.schema.maximum}
          @change=${(e: CustomEvent<{ value: string | number }>) => this._emit(e.detail.value)}
        ></r-input>`;
    }

    return html`<div class="field" data-section-id=${this.sectionId} data-config-key=${this.configKey} data-field-key=${this.key}>${fieldContent}</div>`;
  }
}
