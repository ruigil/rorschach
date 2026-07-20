import {
  customElement,
  html,
  query,
  RorschachBase,
  state,
  StoreController
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

  override createRenderRoot() { return this; }

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

  private _toggleGroup(groupId: string) {
    const next = new Set(this.expandedGroups);
    if (next.has(groupId)) {
      next.delete(groupId);
    } else {
      next.add(groupId);
    }
    this.expandedGroups = next;
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

  override render() {
    const activeSection = this.schemas.find(s => s.id === this.activeSectionId) || this.schemas[0];

    return html`
      <r-panel elevation="1">
        <r-toolbar slot="header-container">
          <div class="config-toolbar-header">
            <span class="config-toolbar-title">Workspace Configuration</span>
            ${activeSection ? html`
              <span class="config-toolbar-breadcrumb">/ ${activeSection.tab} / ${activeSection.title}</span>
            ` : ''}
          </div>
        </r-toolbar>
        <div class="config-content">
          ${this.schemas.length > 0 ? this._renderTree() : ''}
          <form id="config-form" novalidate @submit=${(e: Event) => { e.preventDefault(); this.save(); }}>
            <div id="config-form-container">
              ${this.schemas.map(section => this._renderSection(section))}
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

  private _renderTree() {
    const rawTree = buildConfigTree(this.schemas);
    const { filteredNodes, autoExpandIds } = filterConfigTree(rawTree, this.searchQuery);

    return html`
      <div class="config-sidebar">
        <div class="config-sidebar-header">
          <span class="config-sidebar-title">Config Tree</span>
        </div>
        <div class="config-tree-search">
          <input
            type="text"
            placeholder="Search configuration..."
            .value=${this.searchQuery}
            @input=${this._onSearchInput}
          />
        </div>
        <div class="config-tree">
          ${filteredNodes.map(group => this._renderGroupNode(group, autoExpandIds))}
        </div>
      </div>
    `;
  }

  private _renderGroupNode(group: ConfigTreeNode, autoExpandIds: Set<string>) {
    const isExpanded = this.searchQuery ? autoExpandIds.has(group.id) || this.expandedGroups.has(group.id) : this.expandedGroups.has(group.id);
    const groupHasDirty = group.children?.some(child => child.id && this._isSectionDirty(child.id)) ?? false;

    return html`
      <div class="config-tree-group ${isExpanded ? 'expanded' : ''}">
        <button
          type="button"
          class="config-tree-group-header"
          @click=${() => this._toggleGroup(group.id)}
        >
          <span class="group-label-container">
            <span class="config-tree-chevron">▶</span>
            <span class="group-label">${group.label}</span>
          </span>
          ${groupHasDirty ? html`<span class="tree-dirty-dot" title="Unsaved changes"></span>` : ''}
        </button>
        <div class="config-tree-children">
          ${group.children?.map(child => this._renderSectionNode(child))}
        </div>
      </div>
    `;
  }

  private _renderSectionNode(node: ConfigTreeNode) {
    const isSelected = this.activeSectionId === node.id;
    const isDirty = node.id ? this._isSectionDirty(node.id) : false;

    return html`
      <button
        type="button"
        class="config-tree-item ${isSelected ? 'active' : ''}"
        data-section-id="${node.id}"
        @click=${() => node.section && this._selectSection(node.section)}
      >
        <span class="config-tree-item-title">${node.label}</span>
        ${isDirty ? html`<span class="tree-dirty-dot" title="Unsaved changes"></span>` : ''}
      </button>
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
