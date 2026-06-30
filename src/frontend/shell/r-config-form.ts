import { html } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import { RorschachBase } from '@rorschach/frontend/webkit/base.js';
import { StoreController } from '@rorschach/frontend/webkit/store-controller.js';
import type { ShellState } from '../types/state.js';
import type { ConfigFieldChangeEvent } from './config-widgets/r-config-field.js';
import { pluginIdFromSection, resolvePath, writeAtPath } from './config-widgets/path-utils.js';
import './config-widgets/r-config-field.js';

type ConfigSchema = {
  id: string;
  tab: string;
  title: string;
  subtitle?: string;
  configKey?: string;
  schema: any;
};

@customElement('r-config-form')
export class RConfigForm extends RorschachBase {
  @state() private schemas: ConfigSchema[] = [];
  @state() private currentValues: Record<string, any> = {};
  @state() private models: string[] = [];
  @state() private activeTab: string | null = null;
  @state() private activeSectionId: string | null = null;

  @query('#flash-msg') private _flashMsg!: any;

  private _currentUserRoles = new StoreController<ShellState, 'currentUserRoles'>(this, ['shell', 'currentUserRoles']);
  private _currentUserId = new StoreController<ShellState, 'currentUserId'>(this, ['shell', 'currentUserId']);
  private _hasLoaded = false;

  override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('tab-change', (e: any) => { this.activeTab = e.detail?.tab; });
    this.addEventListener('config-field-change', this._onFieldChange as EventListener);
  }

  private _onFieldChange = (e: ConfigFieldChangeEvent) => {
    const { sectionId, configKey, key, value } = e.detail;
    const pluginId = pluginIdFromSection(sectionId);
    const next = { ...this.currentValues };
    const pluginValues = next[pluginId] ?? {};
    const updated = structuredClone(pluginValues);
    const target = resolvePath(updated, configKey);
    target[key] = value;
    next[pluginId] = updated;
    this.currentValues = next;
  };

  override willUpdate(changedProperties: Map<string, any>) {
    if (changedProperties.has('activeTab') || changedProperties.has('schemas')) {
      const tab = this.activeTab;
      if (tab) {
        const sections = this.schemas.filter(s => s.tab === tab);
        if (sections.length > 0) {
          if (!this.activeSectionId || !sections.some(s => s.id === this.activeSectionId)) {
            this.activeSectionId = sections[0]?.id || null;
          }
        } else {
          this.activeSectionId = null;
        }
      } else {
        this.activeSectionId = null;
      }
    }
  }

  override updated() {
    if (!this._hasLoaded && this._currentUserId.value !== null) {
      if (this._canUseAdminSurface()) {
        this._hasLoaded = true;
        this.loadSchemas();
      }
    }
  }

  private _canUseAdminSurface() {
    const roles = this._currentUserRoles.value as string[] | undefined;
    const userId = this._currentUserId.value;
    return userId === 'anonymous' || (roles?.includes('admin') ?? false);
  }

  async loadSchemas() {
    await this._fetchConfigSchema();
    if (this.schemas.length === 0) return;
    if (!this.activeTab) this.activeTab = this.schemas[0]?.tab || null;
    await Promise.all([this._fetchCurrentValues(), this._fetchModels()]);
    this.requestUpdate();
  }

  private async _fetchConfigSchema() {
    try {
      const res = await fetch(new URL('config/schema', location.href));
      if (res.ok) this.schemas = await res.json();
    } catch {}
  }

  private async _fetchCurrentValues() {
    const pluginPaths = [...new Set(this.schemas.map(s => {
      const pluginId = s.id.split('.')[0];
      return `/config/${pluginId}`;
    }))];
    for (const path of pluginPaths) {
      try {
        const res = await fetch(new URL(path.slice(1), location.href));
        if (res.ok) {
          const pluginId = path.split('/').pop()!;
          this.currentValues = { ...this.currentValues, [pluginId]: await res.json() };
        }
      } catch {}
    }
  }

  private async _fetchModels() {
    try {
      const res = await fetch(new URL('models', location.href));
      if (res.ok) this.models = await res.json();
    } catch {}
  }

  async save() {
    const activeSchemas = this.schemas.filter(s => s.tab === this.activeTab);
    const activePluginIds = new Set(activeSchemas.map(s => s.id.split('.')[0]));
    for (const [pluginId, patch] of Object.entries(this.currentValues)) {
      if (!activePluginIds.has(pluginId)) continue;
      try {
        const res = await fetch(new URL(`config/${pluginId}`, location.href), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(`server error ${res.status}`);
      } catch (err: any) {
        this._flashError(`Failed to save ${pluginId}: ${err.message}`);
        return;
      }
    }
    this._flashSaved();
  }

  reset() {
    this.loadSchemas();
  }

  override render() {
    const byTab: Record<string, ConfigSchema[]> = {};
    for (const s of this.schemas) (byTab[s.tab] ??= []).push(s);
    const tabNames = Object.keys(byTab);
    const activeSections = byTab[this.activeTab ?? ''] ?? [];

    return html`
      <r-panel elevation="1">
        <r-toolbar slot="header-container">
          <r-tabs @tab-change=${(e: CustomEvent) => this.activeTab = e.detail.tab}>
            ${tabNames.map(tab => html`
              <button ?active=${this.activeTab === tab} data-tab="${tab}">${tab}</button>
            `)}
          </r-tabs>
        </r-toolbar>
        <div class="config-content">
          ${activeSections.length > 0 ? html`
            <div class="config-sidebar">
              <div class="config-sidebar-menu">
                ${activeSections.map(section => html`
                  <button type="button"
                          class="config-sidebar-item ${this.activeSectionId === section.id ? 'active' : ''}"
                          @click=${() => this.activeSectionId = section.id}>
                    <span class="config-sidebar-item-title">${section.title}</span>
                  </button>
                `)}
              </div>
            </div>
          ` : ''}
          <form id="config-form" novalidate @submit=${(e: Event) => { e.preventDefault(); this.save(); }}>
            <div id="config-form-container">
              ${tabNames.map(tab => html`
                <div class="config-pane ${this.activeTab === tab ? 'active' : ''}" data-config-pane="${tab}">
                  ${byTab[tab]?.map(section => this._renderSection(section))}
                </div>
              `)}
            </div>
            <div class="form-actions">
              <button type="submit" class="btn-save">Save</button>
              <button type="button" class="btn-reset" id="reset-btn" @click=${this.reset}>Reset</button>
              <r-flash-message id="flash-msg"></r-flash-message>
            </div>
          </form>
        </div>
      </r-panel>
    `;
  }

  private _renderSection(section: ConfigSchema) {
    const pluginId = pluginIdFromSection(section.id);
    const pluginValues = this.currentValues[pluginId] ?? {};
    const configKey = section.configKey ?? '';

    let values = pluginValues;
    if (configKey) {
      for (const part of configKey.split('.')) {
        values = values?.[part] ?? {};
      }
    }

    const props = section.schema.properties ?? {};

    return html`
      <div class="config-section ${this.activeSectionId === section.id ? 'active' : ''}">
        <div class="pane-header">
          <span class="pane-title">${section.title}</span>
          ${section.subtitle ? html`<span class="pane-sub">${section.subtitle}</span>` : ''}
        </div>
        ${Object.entries(props).map(([key, fieldSchema]: [string, any]) =>
          html`<r-config-field
            .sectionId=${section.id}
            .configKey=${configKey}
            .key=${key}
            .schema=${fieldSchema}
            .value=${values[key]}
            .models=${this.models}
            .pluginValues=${pluginValues}
          ></r-config-field>`
        )}
      </div>
    `;
  }

  private _flashSaved() {
    this._flashMsg?.save();
  }

  private _flashError(msg: string) {
    this._flashMsg?.error(msg);
  }
}
