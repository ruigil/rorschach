import { html, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { RorschachBase } from './base.js';

interface ConfigSchema {
  id: string;
  tab: string;
  title: string;
  subtitle?: string;
  configKey?: string;
  schema: any;
}

import { store, StoreController } from '../store.js';

@customElement('r-config-form')
export class RConfigForm extends RorschachBase {
  @state() private schemas: ConfigSchema[] = [];
  @state() private currentValues: Record<string, any> = {};
  @state() private models: string[] = [];
  @state() private activeTab: string | null = null;
  @state() private activeSectionId: string | null = null;

  private _currentUserRoles = new StoreController(this, 'currentUserRoles');
  private _currentUserId = new StoreController(this, 'currentUserId');
  private _hasLoaded = false;

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('tab-change', (e: any) => {
      this.activeTab = e.detail?.tab;
    });
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
    const roles = this._currentUserRoles.value as string[];
    const userId = this._currentUserId.value;
    return userId === 'anonymous' || roles.includes('admin');
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
    } else if (widget === 'model-select') {
      fieldContent = html`
        <label class="field-label" for="${sectionId}-${key}">${label}</label>
        <select id="${sectionId}-${key}" name="${key}" data-section="${sectionId}" data-config-key="${configKey}" data-widget="model-select">
          <option value="">— none —</option>
          ${this.models.map(m => html`
            <option value="${m}" ?selected=${m === resolvedValue}>${m}</option>
          `)}
        </select>
        ${schema.description ? html`<span class="field-hint">${schema.description}</span>` : ''}`;
    } else if (widget === 'textarea') {
      const rows = schema['x-ui']?.rows ?? 3;
      fieldContent = html`
        <label class="field-label" for="${sectionId}-${key}">${label}</label>
        <textarea id="${sectionId}-${key}" name="${key}" rows="${rows}" 
                  data-section="${sectionId}" data-config-key="${configKey}">${resolvedValue}</textarea>
        ${schema.description ? html`<span class="field-hint">${schema.description}</span>` : ''}`;
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

      const value = el.type === 'checkbox' ? el.checked
        : el.type === 'number' ? Number(el.value)
        : el.value;

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
