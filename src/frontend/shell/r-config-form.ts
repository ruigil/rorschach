import {
  css,
  customElement,
  html,
  query,
  RorschachBase,
  state,
  StoreController,
  workspaceStyles,
  type TreeNode
} from '@rorschach/webkit';

import type { ShellState } from './types.js';
import type { ConfigFieldChangeEvent } from './config-widgets/r-config-field.js';
import {
  buildConfigTree,
  filterConfigTree,
  pluginIdFromSection,
  resolvePath,
  writeAtPath,
  type ConfigTreeNode
} from './config-widgets/path-utils.js';
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
  @state() private initialValues: Record<string, any> = {};
  @state() private models: string[] = [];
  @state() private activeTab: string | null = null;
  @state() private activeSectionId: string | null = null;
  @state() private searchQuery: string = '';
  @state() private expandedGroups: Set<string> = new Set();

  @query('#flash-msg') private _flashMsg!: any;

  private _currentUserRoles = new StoreController(this, ['shell', 'currentUserRoles']);
  private _currentUserId = new StoreController(this, ['shell', 'currentUserId']);
  private _hasLoaded = false;

  static override styles = [
    workspaceStyles,
    css`
      :host {
        display: block;
        height: 100%;
        width: 100%;
      }

      .config-actions {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }

      .btn-save {
        padding: 0.35rem 0.9rem;
        background: var(--accent);
        border: none;
        border-radius: var(--radius, 4px);
        color: #03070a;
        font-family: var(--font-ui);
        font-size: 0.7rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        cursor: pointer;
        transition: background 0.15s, box-shadow 0.15s, transform 0.1s;
        box-shadow: 0 2px 10px var(--accent-glow);
      }

      .btn-save:hover {
        background: var(--accent-bright);
        box-shadow: 0 2px 16px rgba(0, 196, 212, 0.4);
        transform: translateY(-1px);
      }

      .btn-save:active {
        transform: translateY(0);
      }

      .btn-reset {
        padding: 0.35rem 0.75rem;
        background: transparent;
        border: 1px solid var(--border-mid);
        border-radius: var(--radius, 4px);
        color: var(--text-dim);
        font-family: var(--font-ui);
        font-size: 0.7rem;
        font-weight: 500;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        cursor: pointer;
        transition: border-color 0.15s, color 0.15s;
      }

      .btn-reset:hover {
        border-color: var(--text-mid);
        color: var(--text);
      }

      .config-search-box {
        padding: 0.5rem 0.5rem 0.25rem 0.5rem;
        border-bottom: 1px solid var(--border);
      }

      .config-search-box input {
        width: 100%;
        padding: 0.4rem 0.6rem;
        background: var(--surface-2);
        border: 1px solid var(--border-mid);
        border-radius: 4px;
        color: var(--text);
        font-family: var(--font-ui);
        font-size: 0.75rem;
        outline: none;
        box-sizing: border-box;
      }

      .config-search-box input:focus {
        border-color: var(--accent);
      }

      .config-section-container {
        flex: 1;
        overflow-y: auto;
        padding: 1.25rem 1.5rem;
        box-sizing: border-box;
      }

      .config-section-container::-webkit-scrollbar { width: 4px; }
      .config-section-container::-webkit-scrollbar-track { background: transparent; }
      .config-section-container::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 2px; }

      .config-section {
        display: none;
        flex-direction: column;
        gap: 1.25rem;
        max-width: 700px;
      }

      .config-section.active {
        display: flex;
      }

      .pane-header {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        padding-bottom: 0.75rem;
        border-bottom: 1px solid var(--border);
        margin-bottom: 0.5rem;
      }

      .pane-title {
        font-size: 0.9rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--text);
        font-family: var(--font-ui);
      }

      .pane-sub {
        font-size: 0.72rem;
        color: var(--text-dim);
        font-family: var(--font-mono);
        font-weight: 300;
      }

      r-config-field {
        display: block;
      }

      .field {
        display: flex;
        flex-direction: column;
        gap: 0.45rem;
        width: 100%;
        max-width: 600px;
      }

      .field-label {
        font-size: 0.72rem;
        font-weight: 500;
        color: var(--text-mid);
        letter-spacing: 0.04em;
      }

      .field-hint {
        font-size: 0.65rem;
        color: var(--text-dim);
        font-family: var(--font-mono);
        font-weight: 300;
      }

      .field textarea {
        width: 100%;
        padding: 0.65rem 0.9rem;
        background: var(--surface-2);
        border: 1px solid var(--border-mid);
        border-radius: var(--radius, 6px);
        color: var(--text);
        font-family: var(--font-mono);
        font-size: 0.82rem;
        font-weight: 400;
        line-height: 1.6;
        resize: vertical;
        outline: none;
        transition: border-color 0.2s, box-shadow 0.2s;
        min-height: 90px;
        box-sizing: border-box;
      }

      .field textarea:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px var(--accent-glow);
      }

      .field input[type="text"],
      .field input[type="number"],
      .field input[type="password"],
      .field select {
        width: 100%;
        padding: 0.55rem 0.85rem;
        background: var(--surface-2);
        border: 1px solid var(--border-mid);
        border-radius: var(--radius, 6px);
        color: var(--text);
        font-family: var(--font-mono);
        font-size: 0.82rem;
        font-weight: 400;
        outline: none;
        transition: border-color 0.2s, box-shadow 0.2s;
        box-sizing: border-box;
      }

      .field input:focus,
      .field select:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px var(--accent-glow);
      }
    `
  ];

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('tab-change', (e: any) => {
      const tab = e.detail?.tab;
      if (tab) {
        this.activeTab = tab;
        const matchingSection = this.schemas.find(s => s.tab === tab);
        if (matchingSection) {
          this.activeSectionId = matchingSection.id;
          const groupNodeId = `group:${tab}`;
          this.expandedGroups = new Set([...this.expandedGroups, groupNodeId]);
        }
      }
    });
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
      if (this.activeTab) {
        const sections = this.schemas.filter(s => s.tab === this.activeTab);
        if (sections.length > 0) {
          if (!this.activeSectionId || !sections.some(s => s.id === this.activeSectionId)) {
            this.activeSectionId = sections[0]?.id || null;
          }
        }
      } else if (this.schemas.length > 0 && !this.activeSectionId) {
        this.activeSectionId = this.schemas[0]?.id || null;
        this.activeTab = this.schemas[0]?.tab || null;
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
    if (!this.activeSectionId) {
      this.activeSectionId = this.schemas[0]?.id || null;
      this.activeTab = this.schemas[0]?.tab || null;
    }
    await Promise.all([this._fetchCurrentValues(), this._fetchModels()]);
    this.initialValues = structuredClone(this.currentValues);
    const tree = buildConfigTree(this.schemas);
    this.expandedGroups = new Set(tree.map(g => g.id));
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
    const activeSection = this.schemas.find(s => s.id === this.activeSectionId);
    const activeTab = activeSection?.tab || this.activeTab;
    const targetPluginIds = new Set(
      this.schemas
        .filter(s => !activeTab || s.tab === activeTab)
        .map(s => s.id.split('.')[0])
    );

    for (const [pluginId, patch] of Object.entries(this.currentValues)) {
      if (targetPluginIds.size > 0 && !targetPluginIds.has(pluginId)) continue;
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
    this.initialValues = structuredClone(this.currentValues);
    this._flashSaved();
  }

  reset() {
    this.loadSchemas();
  }

  private _selectSection(section: ConfigSchema) {
    this.activeSectionId = section.id;
    this.activeTab = section.tab;
  }

  private _onSearchInput = (e: Event) => {
    this.searchQuery = (e.target as HTMLInputElement).value;
  };

  private _isPluginDirty(pluginId: string): boolean {
    if (!this.initialValues[pluginId] || !this.currentValues[pluginId]) return false;
    return JSON.stringify(this.initialValues[pluginId]) !== JSON.stringify(this.currentValues[pluginId]);
  }

  private _isSectionDirty(sectionId: string): boolean {
    const pluginId = pluginIdFromSection(sectionId);
    return this._isPluginDirty(pluginId);
  }

  private get _treeData(): TreeNode[] {
    const rawTree = buildConfigTree(this.schemas);
    const { filteredNodes } = filterConfigTree(rawTree, this.searchQuery);

    return filteredNodes.map(group => {
      const groupHasDirty = group.children?.some(child => child.id && this._isSectionDirty(child.id)) ?? false;
      return {
        id: group.id,
        label: group.label,
        icon: 'folder',
        status: groupHasDirty ? 'warn' : undefined,
        children: group.children?.map(child => {
          const isDirty = child.id ? this._isSectionDirty(child.id) : false;
          return {
            id: child.id,
            label: child.label,
            icon: 'settings',
            status: isDirty ? 'warn' : undefined,
            data: child.section ? { section: child.section } : undefined
          };
        })
      };
    });
  }

  private _onNodeSelect(event: CustomEvent<{ node: TreeNode }>) {
    const node = event.detail?.node;
    if (node?.data?.section) {
      this._selectSection(node.data.section);
    } else if (node?.id) {
      const section = this.schemas.find(s => s.id === node.id);
      if (section) this._selectSection(section);
    }
  }

  override render() {
    const activeSection = this.schemas.find(s => s.id === this.activeSectionId) || this.schemas[0];
    const activeLabel = activeSection ? `${activeSection.tab} / ${activeSection.title}` : 'Configuration';

    return html`
      <r-panel elevation="1" style="height: 100%; display: flex; flex-direction: column;">
        <r-toolbar slot="header-container">
          <div class="ws-header-title">
            <span class="ws-title-base">Configuration</span>
            <span class="ws-title-sep">/</span>
            <span class="ws-title-active">${activeLabel}</span>
          </div>
          <div slot="actions" class="config-actions">
            <r-flash-message id="flash-msg"></r-flash-message>
            <button type="button" class="btn-reset" id="reset-btn" @click=${this.reset}>Reset</button>
            <button type="button" class="btn-save" @click=${this.save}>Save</button>
          </div>
        </r-toolbar>

        <div class="ws-body">
          <aside class="ws-sidebar">
            <div class="config-search-box">
              <input
                type="text"
                placeholder="Search configuration..."
                .value=${this.searchQuery}
                @input=${this._onSearchInput}
              />
            </div>
            <div class="ws-sidebar-tree">
              <r-tree
                .data=${this._treeData}
                .selectedId=${this.activeSectionId}
                @node-select=${this._onNodeSelect}
              ></r-tree>
            </div>
          </aside>

          <main class="ws-main">
            <div class="config-section-container">
              ${this.schemas.map(section => this._renderSection(section))}
            </div>
          </main>
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
      <div class="config-section ${this.activeSectionId === section.id ? 'active' : ''}" data-section-id="${section.id}">
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
