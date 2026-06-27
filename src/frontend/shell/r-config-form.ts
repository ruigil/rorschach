import { html, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { RorschachBase } from '@rorschach/frontend/webkit/base.js';

type ConfigSchema = {
  id: string;
  tab: string;
  title: string;
  subtitle?: string;
  configKey?: string;
  schema: any;
};

import { StoreController } from '@rorschach/frontend/webkit/store-controller.js';
import type { ShellState } from '../types/state.js';

@customElement('r-config-form')
export class RConfigForm extends RorschachBase {
  @state() private schemas: ConfigSchema[] = [];
  @state() private currentValues: Record<string, any> = {};
  @state() private models: string[] = [];
  @state() private activeTab: string | null = null;
  @state() private activeSectionId: string | null = null;
  @state() private openDropdowns: Record<string, boolean> = {};
  @state() private searchQueries: Record<string, string | null> = {};
  @state() private activeFilterTypes: Record<string, 'allow' | 'deny'> = {};

  private _currentUserRoles = new StoreController<ShellState, 'currentUserRoles'>(this, ['shell', 'currentUserRoles']);
  private _currentUserId = new StoreController<ShellState, 'currentUserId'>(this, ['shell', 'currentUserId']);
  private _hasLoaded = false;

  private _onOutsideClick = (e: MouseEvent) => {
    let clickedInside = false;
    for (const key of Object.keys(this.openDropdowns)) {
      const container = this.querySelector(`[id="container-${key}"]`);
      if (container && container.contains(e.target as Node)) {
        clickedInside = true;
      }
    }
    if (!clickedInside) {
      this.openDropdowns = {};
      this.searchQueries = {};
    }
  }

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('tab-change', (e: any) => {
      this.activeTab = e.detail?.tab;
    });
    window.addEventListener('click', this._onOutsideClick);
  }

  override disconnectedCallback() {
    window.removeEventListener('click', this._onOutsideClick);
    super.disconnectedCallback();
  }

  private _openDropdown(fieldId: string) {
    this.openDropdowns = { [fieldId]: true };
  }

  private _onSearchInput(e: any, fieldId: string) {
    this.searchQueries = { ...this.searchQueries, [fieldId]: e.target.value };
  }

  private _selectModel(id: string, name: string, fieldId: string, sectionId: string, configKey: string, key: string) {
    const pluginId = sectionId.split('.')[0]!;
    
    // Copy currentValues recursively to ensure reactivity triggers properly
    const newValues = JSON.parse(JSON.stringify(this.currentValues));
    
    let target = newValues[pluginId] ??= {};
    if (configKey) {
      for (const part of configKey.split('.')) {
        target = target[part] ??= {};
      }
    }
    target[key] = id;
    
    this.currentValues = newValues;

    // Clear dropdown and search states
    this.openDropdowns = { ...this.openDropdowns, [fieldId]: false };
    this.searchQueries = { ...this.searchQueries, [fieldId]: null };
  }

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

  override updated(changedProperties: Map<string, any>) {
    if (!this._hasLoaded && this._currentUserId.value !== null) {
      if (this._canUseAdminSurface()) {
        this._hasLoaded = true;
        this.loadSchemas();
      }
    }

    // Re-trigger if new widgets appeared
    this.querySelectorAll('[data-widget="google-account"]').forEach(el => {
      if (!(el as any)._initialized) {
        (el as any)._initialized = true;
        el.dispatchEvent(new CustomEvent('hook-google-status', { bubbles: false }));
      }
    });
  }

  private _canUseAdminSurface() {
    const roles = this._currentUserRoles.value as string[] | undefined;
    const userId = this._currentUserId.value;
    return userId === 'anonymous' || (roles?.includes('admin') ?? false);
  }

  async loadSchemas() {
    await this._fetchConfigSchema();
    if (this.schemas.length === 0) return;
    
    if (!this.activeTab) {
      this.activeTab = this.schemas[0]?.tab || null;
    }

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
    console.log('[RConfigForm] save() initiated');
    const byPlugin = this._gatherValuesByPlugin();
    console.log('[RConfigForm] Gathered config values:', byPlugin);
    
    const activeSchemas = this.schemas.filter(s => s.tab === this.activeTab);
    const activePluginIds = new Set(activeSchemas.map(s => s.id.split('.')[0]));
    console.log('[RConfigForm] Active plugin IDs to save:', Array.from(activePluginIds));

    for (const [pluginId, patch] of Object.entries(byPlugin)) {
      if (!activePluginIds.has(pluginId)) {
        console.log(`[RConfigForm] Skipping save for inactive plugin "${pluginId}"`);
        continue;
      }
      try {
        console.log(`[RConfigForm] POSTing config patch for plugin "${pluginId}":`, patch);
        const res = await fetch(new URL(`config/${pluginId}`, location.href), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(`server error ${res.status}`);
        console.log(`[RConfigForm] Successfully saved plugin "${pluginId}"`);
      } catch (err: any) {
        console.error(`[RConfigForm] Failed to save plugin "${pluginId}":`, err);
        this._flashError(`Failed to save ${pluginId}: ${err.message}`);
        return;
      }
    }
    console.log('[RConfigForm] Active plugins saved, flashing success message...');
    this._flashSaved();
  }

  reset() {
    this.loadSchemas();
  }

  override render() {
    const byTab: Record<string, ConfigSchema[]> = {};
    for (const s of this.schemas) {
      (byTab[s.tab] ??= []).push(s);
    }
    const tabNames = Object.keys(byTab);
    const activeSections = byTab[this.activeTab ?? ''] ?? [];

    return html`
      <div class="config-bar">
        <r-tabs class="config-subtabs" id="config-tabs">
          ${tabNames.map((tab, i) => html`
            <button class="config-subtab ${this.activeTab === tab ? 'active' : ''}" 
                    data-config-tab="${tab}"
                    @click=${() => this.activeTab = tab}>
              ${tab}
            </button>
          `)}
        </r-tabs>
      </div>
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
    `;
  }

  private _renderSection(section: ConfigSchema) {
    const pluginId = section.id.split('.')[0] ?? 0;
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
          this._renderField(section.id, configKey, key, fieldSchema, values[key])
        )}
      </div>
    `;
  }

  private _renderField(sectionId: string, configKey: string, key: string, schema: any, value: any) {
    const widget = schema['x-ui']?.widget ?? this._inferWidget(schema);
    const secret = schema['x-ui']?.secret ?? false;
    const label = schema['x-ui']?.label ?? key;
    const resolvedValue = value ?? schema.default ?? '';

    let fieldContent: TemplateResult;

    if (widget === 'toggle') {
      fieldContent = html`
        <div class="field-row">
          <div>
            <div class="field-label">${label}</div>
            ${schema.description ? html`<div class="field-hint">${schema.description}</div>` : ''}
          </div>
          <label class="toggle">
            <input type="checkbox" name="${key}" .checked=${!!resolvedValue} 
                   data-section="${sectionId}" data-config-key="${configKey}">
            <span class="toggle-track"></span>
          </label>
        </div>`;
    } else if (widget === 'select') {
      fieldContent = html`
        <label class="field-label" for="${sectionId}-${key}">${label}</label>
        <select id="${sectionId}-${key}" name="${key}" data-section="${sectionId}" data-config-key="${configKey}">
          ${(schema.enum ?? []).map((v: string) => html`
            <option value="${v}" ?selected=${v === resolvedValue}>${v}</option>
          `)}
        </select>
        ${schema.description ? html`<span class="field-hint">${schema.description}</span>` : ''}`;
    } else if (widget === 'voice-select') {
      const pluginId = sectionId.split('.')[0] ?? '';
      const pluginValues = this.currentValues[pluginId] ?? {};
      let values = pluginValues;
      if (configKey) {
        for (const part of configKey.split('.')) {
          values = values?.[part] ?? {};
        }
      }
      const selectedTtsModel = values.ttsModel || values.model || '';
      let modelVoices: string[] = [];
      if (selectedTtsModel) {
        const modelEntry = this.models.find(m => m.startsWith(selectedTtsModel + '|'));
        if (modelEntry) {
          const parts = modelEntry.split('|');
          if (parts[2]) {
            modelVoices = parts[2].split(',').filter(Boolean);
          }
        }
      }
      if (modelVoices.length === 0) {
        modelVoices = schema.enum ?? ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
      }

      fieldContent = html`
        <label class="field-label" for="${sectionId}-${key}">${label}</label>
        <select id="${sectionId}-${key}" name="${key}" data-section="${sectionId}" data-config-key="${configKey}">
          ${modelVoices.map((v: string) => html`
            <option value="${v}" ?selected=${v === resolvedValue}>${v}</option>
          `)}
        </select>
        ${schema.description ? html`<span class="field-hint">${schema.description}</span>` : ''}`;
    } else if (widget === 'model-select') {
      const resolvedValue = value ?? schema.default ?? '';

      let selectedModelName = '';
      if (resolvedValue) {
        for (const m of this.models) {
          const parts = m.split('|');
          if (parts[0] === resolvedValue) {
            selectedModelName = parts[1] || parts[0] || '';
            break;
          }
        }
      }

      const isOpen = this.openDropdowns[`${sectionId}-${key}`] ?? false;
      const searchQuery = this.searchQueries[`${sectionId}-${key}`] ?? null;
      const displayVal = searchQuery !== null ? searchQuery : (selectedModelName || resolvedValue);

      const query = (searchQuery ?? '').toLowerCase();
      const filteredModels = this.models.filter(m => {
        const parts = m.split('|');
        const id = parts[0]!;
        const name = parts[1] || id;
        return name.toLowerCase().includes(query);
      });

      fieldContent = html`
        <label class="field-label" for="${sectionId}-${key}">${label}</label>
        <div class="custom-select-container" id="container-${sectionId}-${key}">
          <input type="text" 
                 class="custom-select-input" 
                 placeholder="Select model..." 
                 .value="${displayVal}"
                 @focus=${(e: any) => {
                   this._openDropdown(`${sectionId}-${key}`);
                   e.target.select();
                 }}
                 @input=${(e: any) => this._onSearchInput(e, `${sectionId}-${key}`)}>
          
          <input type="hidden" 
                 id="${sectionId}-${key}" 
                 name="${key}" 
                 data-section="${sectionId}" 
                 data-config-key="${configKey}" 
                 data-widget="model-select"
                 .value="${resolvedValue}">

          ${isOpen ? html`
            <div class="custom-select-dropdown">
              <div class="custom-select-item" @click=${() => this._selectModel('', '', `${sectionId}-${key}`, sectionId, configKey, key)}>
                — none —
              </div>
              ${filteredModels.map(m => {
                const parts = m.split('|');
                const id = parts[0]!;
                const name = parts[1] || id;
                return html`
                  <div class="custom-select-item ${id === resolvedValue ? 'selected' : ''}" 
                       @click=${() => this._selectModel(id, name, `${sectionId}-${key}`, sectionId, configKey, key)}>
                    <span class="model-item-name">${name}</span>
                    <span class="model-item-id">${id}</span>
                  </div>
                `;
              })}
            </div>
          ` : ''}
        </div>
        ${schema.description ? html`<span class="field-hint">${schema.description}</span>` : ''}`;
    } else if (widget === 'tool-filter') {
      const fieldId = `${sectionId}-${key}`;
      let activeType = this.activeFilterTypes[fieldId];
      if (!activeType) {
        if (resolvedValue && typeof resolvedValue === 'object') {
          activeType = ('deny' in resolvedValue) ? 'deny' : 'allow';
        } else {
          activeType = 'allow';
        }
        this.activeFilterTypes = { ...this.activeFilterTypes, [fieldId]: activeType };
      }

      const nextConfigKey = configKey ? `${configKey}.${key}` : key;
      const arrayVal = (resolvedValue && typeof resolvedValue === 'object')
        ? (resolvedValue[activeType] ?? [])
        : [];
      const displayVal = Array.isArray(arrayVal) ? arrayVal.join(', ') : '';

      fieldContent = html`
        <label class="field-label" for="${sectionId}-${key}">${label}</label>
        <div class="tool-filter-container" style="display: flex; gap: 8px; align-items: center;">
          <select style="width: auto; flex-shrink: 0;" @change=${(e: any) => {
            this.activeFilterTypes = { ...this.activeFilterTypes, [fieldId]: e.target.value as 'allow' | 'deny' };
          }}>
            <option value="allow" ?selected=${activeType === 'allow'}>Allow only</option>
            <option value="deny" ?selected=${activeType === 'deny'}>Deny only</option>
          </select>
          <input type="text" 
                 id="${sectionId}-${key}" 
                 name="${activeType}" 
                 .value="${displayVal}" 
                 placeholder="e.g. tool_name_1, tool_name_2"
                 data-type="array"
                 data-section="${sectionId}" 
                 data-config-key="${nextConfigKey}">
        </div>
        ${schema.description ? html`<span class="field-hint">${schema.description}</span>` : ''}`;
    } else if (widget === 'textarea') {
      const rows = schema['x-ui']?.rows ?? 3;
      fieldContent = html`
        <label class="field-label" for="${sectionId}-${key}">${label}</label>
        <textarea id="${sectionId}-${key}" name="${key}" rows="${rows}" 
                  data-section="${sectionId}" data-config-key="${configKey}">${resolvedValue}</textarea>
        ${schema.description ? html`<span class="field-hint">${schema.description}</span>` : ''}`;
    } else if (widget === 'object') {
      const subProps = schema.properties ?? {};
      const nextConfigKey = configKey ? `${configKey}.${key}` : key;
      fieldContent = html`
        <div class="nested-object-label">${label}</div>
        <div class="nested-object-fields">
          ${Object.entries(subProps).map(([subKey, subSchema]: [string, any]) =>
            this._renderField(sectionId, nextConfigKey, subKey, subSchema, (typeof resolvedValue === 'object' && resolvedValue !== null) ? (resolvedValue as any)[subKey] : undefined)
          )}
        </div>
      `;
    } else if (widget === 'google-account') {
      fieldContent = this._renderGoogleAccountWidget();
    } else {
      const inputType = secret ? 'password' : widget === 'number' ? 'number' : 'text';
      fieldContent = html`
        <label class="field-label" for="${sectionId}-${key}">${label}</label>
        <input type="${inputType}" id="${sectionId}-${key}" name="${key}" .value="${resolvedValue}" 
               data-section="${sectionId}" data-config-key="${configKey}"
               ?min=${schema.minimum != null} .min=${schema.minimum}
               ?max=${schema.maximum != null} .max=${schema.maximum}
               placeholder="${schema.default ?? ''}">
        ${schema.description ? html`<span class="field-hint">${schema.description}</span>` : ''}`;
    }

    return html`
      <div class="field" data-section-id="${sectionId}" data-config-key="${configKey}" data-field-key="${key}">
        ${fieldContent}
      </div>
    `;
  }

  private _renderGoogleAccountWidget() {
    return html`
      <div class="field-row" data-widget="google-account" @hook-google-status=${this._initGoogleAccountWidget}>
        <div>
          <div class="field-label">Google account</div>
          <div class="field-hint" data-google-status>checking…</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button type="button" class="btn-save" data-google-connect style="display:none">Connect</button>
          <button type="button" class="btn-reset" data-google-disconnect style="display:none">Disconnect</button>
        </div>
      </div>`;
  }

  private _initGoogleAccountWidget(e: Event) {
    const wrapper = e.target as HTMLElement;
    const statusEl = wrapper.querySelector('[data-google-status]') as HTMLElement;
    const connectBtn = wrapper.querySelector('[data-google-connect]') as HTMLElement;
    const disconnectBtn = wrapper.querySelector('[data-google-disconnect]') as HTMLElement;

    const updateStatus = async () => {
      try {
        const res = await fetch(new URL('googleapis/auth/status', location.href));
        const data = res.ok ? await res.json() : { connected: false };
        if (data.connected) {
          statusEl.textContent = 'Connected';
          connectBtn.style.display = 'none';
          disconnectBtn.style.display = '';
        } else {
          statusEl.textContent = 'Not connected';
          connectBtn.style.display = '';
          disconnectBtn.style.display = 'none';
        }
      } catch {
        statusEl.textContent = 'Status unavailable';
      }
    };

    connectBtn.addEventListener('click', () => {
      const popup = window.open(new URL('googleapis/auth/start', location.href), '_blank', 'width=520,height=640');
      const poll = setInterval(() => {
        if (popup?.closed) {
          clearInterval(poll);
          updateStatus();
        }
      }, 500);
    });

    disconnectBtn.addEventListener('click', async () => {
      await fetch(new URL('googleapis/auth/revoke', location.href), { method: 'POST' });
      updateStatus();
    });

    updateStatus();
  }

  override firstUpdated() {
    // We need to trigger Google account widget initialization after first render
    this.querySelectorAll('[data-widget="google-account"]').forEach(el => {
      el.dispatchEvent(new CustomEvent('hook-google-status', { bubbles: false }));
    });
  }

  private _inferWidget(schema: any) {
    if (schema.oneOf && schema.oneOf.some((s: any) => s.properties && ('allow' in s.properties || 'deny' in s.properties))) {
      return 'tool-filter';
    }
    if (schema.type === 'object') return 'object';
    if (schema.type === 'boolean') return 'toggle';
    if (schema.type === 'number') return 'number';
    if (schema.enum) return 'select';
    return 'text';
  }

  private _gatherValuesByPlugin() {
    const byPlugin: Record<string, any> = {};
    this.querySelectorAll('[data-config-key]').forEach((el: any) => {
      if (el.dataset.widget === 'google-account') return;
      if (!el.name || !el.dataset.section) return;
      const pluginId = el.dataset.section.split('.')[0];
      const configKey = el.dataset.configKey;
      const key = el.name;
      if (!key) return;

      let value = el.type === 'checkbox' ? el.checked
        : el.type === 'number' ? Number(el.value)
        : el.value;

      if (el.dataset.type === 'array') {
        value = typeof el.value === 'string'
          ? el.value.split(',').map((s: string) => s.trim()).filter(Boolean)
          : [];
      }

      (byPlugin[pluginId] ??= {});

      if (configKey) {
        const parts = configKey.split('.');
        let target = byPlugin[pluginId];
        for (let i = 0; i < parts.length; i++) {
          target = target[parts[i]] ??= {};
        }
        target[key] = value;
      } else {
        byPlugin[pluginId][key] = value;
      }
    });
    return byPlugin;
  }

  private _flashSaved() {
    const flash = this.querySelector('#flash-msg') as any;
    console.log('[RConfigForm] _flashSaved() called. Found flash-msg element:', flash);
    if (flash) {
      flash.save();
    } else {
      console.warn('[RConfigForm] #flash-msg element not found in DOM!');
    }
  }

  private _flashError(msg: string) {
    const flash = this.querySelector('#flash-msg') as any;
    console.error('[RConfigForm] _flashError() called with message:', msg, '. Found flash-msg element:', flash);
    if (flash) {
      flash.error(msg);
    } else {
      console.warn('[RConfigForm] #flash-msg element not found in DOM!');
    }
  }
}
