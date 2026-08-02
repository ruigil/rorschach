import {
  css,
  customElement,
  html,
  nothing,
  query,
  RorschachBase,
  sharedStyles,
  state,
  store,
  StoreController,
  workspaceStyles,
  type TreeNode,
} from '@rorschach/webkit';

import type { ConfigUIState } from './index.js';
import {
  isConfigConverging,
  configSyncStatus,
  normalizeArray,
  noteAcceptedRevision,
  pluginSyncStatus,
  refreshConfigPlugins,
  refreshConfigSchemas,
  refreshConfigSystems,
  syncMissingValues,
  type SystemSummary,
} from './index.js';
import {
  buildConfigTree,
  filterConfigTree,
  pluginIdFromSection,
  resolvePath,
  type ConfigTreeNode,
} from './widgets/path-utils.js';
import type { ConfigFieldChangeEvent } from './widgets/r-config-field.js';
import './widgets/r-config-field.js';

/** UI-only soft-warn list — kernel does not block unload of these. */
const CORE_PLUGIN_IDS = ['interfaces', 'config'] as const;

type ConfigSchema = {
  id: string;
  tab: string;
  title: string;
  subtitle?: string;
  configKey?: string;
  schema: any;
};

/** Read the value at a dotted path ('a.b.c') within `root`, or undefined. */
const getAtDotPath = (root: any, dotPath: string): any =>
  dotPath.split('.').reduce((o, part) => o?.[part], root);

/** Write `value` at a dotted path within `root`, creating intermediate objects. */
const setAtDotPath = (root: Record<string, any>, dotPath: string, value: unknown): void => {
  const parts = dotPath.split('.');
  const leaf = parts.pop()!;
  resolvePath(root, parts.join('.'))[leaf] = value;
};

@customElement('r-config-panel')
export class RConfigPanel extends RorschachBase {
  private _activeSystemIdStore = new StoreController(this, ['config', 'activeSystemId']);
  private _systemsStore = new StoreController(this, ['config', 'systems']);
  private _pluginsStore = new StoreController(this, ['config', 'plugins']);
  private _schemasStore = new StoreController(this, ['config', 'schemas']);
  private _currentValuesStore = new StoreController(this, ['config', 'currentValues']);
  private _dirtyStore = new StoreController(this, ['config', 'dirtyFields']);
  private _loadingStore = new StoreController(this, ['config', 'loading']);
  private _errorStore = new StoreController(this, ['config', 'error']);
  private _addInputPathStore = new StoreController(this, ['config', 'addInputPath']);
  private _isSubmittingStore = new StoreController(this, ['config', 'isSubmitting']);
  private _pendingRevisionStore = new StoreController(this, ['config', 'pendingRevision']);
  private _observedRevisionStore = new StoreController(this, ['config', 'observedRevision']);
  private _appliedRevisionStore = new StoreController(this, ['config', 'appliedRevision']);

  @state() private models: string[] = [];
  @state() private selectedNodeId: string | null = null;
  @state() private activeSectionId: string | null = null;
  @state() private searchQuery: string = '';

  @query('#flash-msg') private _flashMsg!: any;

  private _currentUserId = new StoreController(this, ['shell', 'currentUserId']);
  private _hasLoadedSchemas = false;

  private get schemas(): ConfigSchema[] {
    return normalizeArray(this._schemasStore.value);
  }

  private get systems(): SystemSummary[] {
    return (normalizeArray(this._systemsStore.value) as SystemSummary[]);
  }

  private get activeSystemId(): string {
    return (this._activeSystemIdStore.value as string) || 'local';
  }

  /** The system currently selected/edited (falls back to the first observed). */
  private get activeSystem(): SystemSummary | null {
    return this.systems.find(s => s.systemId === this.activeSystemId)
      ?? this.systems[0]
      ?? null;
  }

  private get currentValues(): Record<string, any> {
    return (this._currentValuesStore.value as Record<string, any>) ?? {};
  }

  static override styles = [
    sharedStyles,
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
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        transition: border-color 0.15s, color 0.15s;
      }

      .btn-reset:hover {
        border-color: var(--text-mid);
        color: var(--text);
      }

      .btn-save:disabled,
      .btn-reset:disabled {
        opacity: 0.45;
        cursor: default;
        pointer-events: none;
      }

      .converge-badge {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.2rem 0.55rem;
        border-radius: 999px;
        font-family: var(--font-ui);
        font-size: 0.65rem;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--accent-bright, #00c4d4);
        background: color-mix(in srgb, var(--accent, #00c4d4) 15%, transparent);
        border: 1px solid color-mix(in srgb, var(--accent, #00c4d4) 35%, transparent);
      }

      .converge-badge::before {
        content: '';
        width: 0.4rem;
        height: 0.4rem;
        border-radius: 50%;
        background: currentColor;
        animation: converge-pulse 1.2s ease-in-out infinite;
      }

      .converge-badge.synced {
        color: var(--ok, #46d17b);
        background: color-mix(in srgb, var(--ok, #46d17b) 15%, transparent);
        border: 1px solid color-mix(in srgb, var(--ok, #46d17b) 35%, transparent);
      }

      .converge-badge.synced::before {
        animation: none;
      }

      .converge-badge.degraded {
        color: var(--error, #e5484d);
        background: color-mix(in srgb, var(--error, #e5484d) 15%, transparent);
        border: 1px solid color-mix(in srgb, var(--error, #e5484d) 35%, transparent);
      }

      @keyframes converge-pulse {
        0%, 100% { opacity: 0.35; }
        50% { opacity: 1; }
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

      .plugin-details-wrap {
        padding: 1.5rem;
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
        overflow-y: auto;
        height: 100%;
        box-sizing: border-box;
      }

      .plugin-header-card {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        border-bottom: 1px solid var(--border);
        padding-bottom: 1rem;
      }

      .plugin-title-area {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }

      .plugin-title-row {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }

      .plugin-title {
        font-size: 1.25rem;
        font-weight: 600;
        font-family: var(--font-mono, monospace);
        margin: 0;
      }

      .plugin-subtitle-path {
        font-size: 0.75rem;
        color: var(--text-dim);
        font-family: var(--font-mono, monospace);
        margin: 0;
      }

      .plugin-version-badge {
        font-size: 0.72rem;
        color: var(--text-dim);
        background: var(--surface-3, var(--surface));
        padding: 0.15rem 0.4rem;
        border-radius: 4px;
        border: 1px solid var(--border);
      }

      .plugin-badges {
        display: flex;
        gap: 0.5rem;
        align-items: center;
      }

      .error-banner {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        background: var(--error-bg);
        border: 1px solid var(--error-border);
        color: var(--error);
        padding: 0.75rem 1rem;
        border-radius: var(--radius, 8px);
        font-size: 0.85rem;
        font-family: var(--font-mono, monospace);
      }

      .health-detail-banner {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        padding: 0.75rem 1rem;
        border-radius: var(--radius, 8px);
        font-size: 0.85rem;
      }

      .health-detail-banner.degraded {
        background: var(--warn-bg, rgba(230, 162, 60, 0.1));
        border: 1px solid var(--warn-border, rgba(230, 162, 60, 0.2));
        color: var(--warn, #e6a23c);
      }

      .health-detail-banner.failed {
        background: var(--error-bg);
        border: 1px solid var(--error-border);
        color: var(--error);
      }

      .plugin-actions-row {
        display: flex;
        gap: 0.75rem;
        margin-top: 1rem;
      }

      .add-form-wrap {
        padding: 1.5rem;
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
        max-width: 600px;
        box-sizing: border-box;
      }

      .add-form-header {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }

      .add-form-title {
        font-size: 1.25rem;
        font-weight: 600;
        margin: 0;
      }

      .add-form-subtitle {
        font-size: 0.85rem;
        color: var(--text-dim);
        margin: 0;
      }

      .add-form {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        background: var(--surface-2);
        border: 1px solid var(--border);
        padding: 1.5rem;
        border-radius: var(--radius, 8px);
      }

      .add-input {
        width: 100%;
      }

      .config-section-container {
        flex: 1;
        overflow-y: auto;
        padding: 1.25rem 1.5rem;
        box-sizing: border-box;
      }

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

      .toolbar-spinning {
        animation: spin 1.5s linear infinite;
      }

      @keyframes spin {
        100% {
          transform: rotate(360deg);
        }
      }
    `,
  ];

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('config-field-change', this._onFieldChange as EventListener);
  }

  override firstUpdated() {
    refreshConfigPlugins();
    refreshConfigSystems();
  }

  override updated() {
    if (!this._hasLoadedSchemas && this._currentUserId.value != null) {
      this._hasLoadedSchemas = true;
      this.loadSchemas();
    }
  }

  private _onFieldChange = (e: ConfigFieldChangeEvent) => {
    const { sectionId, configKey, key, value } = e.detail;
    const pluginId = pluginIdFromSection(sectionId);
    const dotPath = configKey ? `${configKey}.${key}` : key;
    const ns = store.namespace<ConfigUIState>('config');

    // Update the displayed values.
    const current = { ...ns.get('currentValues') };
    const pluginValues = structuredClone(current[pluginId] ?? {});
    setAtDotPath(pluginValues, dotPath, value);
    current[pluginId] = pluginValues;
    ns.set('currentValues', current);

    // Track the edit as dirty only while it diverges from the server baseline.
    const initial = getAtDotPath(ns.get('initialValues')[pluginId], dotPath);
    const dirty = { ...ns.get('dirtyFields') };
    const pluginDirty = { ...(dirty[pluginId] ?? {}) };
    if (JSON.stringify(initial) === JSON.stringify(value)) {
      delete pluginDirty[dotPath];
    } else {
      pluginDirty[dotPath] = value;
    }
    if (Object.keys(pluginDirty).length === 0) {
      delete dirty[pluginId];
    } else {
      dirty[pluginId] = pluginDirty;
    }
    ns.set('dirtyFields', dirty);
  };

  async loadSchemas() {
    await refreshConfigSchemas();
    if (this.schemas.length === 0) return;
    if (!this.activeSectionId && this.selectedNodeId?.startsWith('sec-')) {
      this.activeSectionId = this.selectedNodeId.slice(4);
    }
    await Promise.all([syncMissingValues(), this._fetchModels()]);
  }

  private async _fetchModels() {
    try {
      const res = await fetch(new URL('models', location.href));
      if (res.ok) {
        const data = await res.json();
        this.models = normalizeArray(data);
      }
    } catch {}
  }

  /** The plugin whose configuration section is currently active, if any. */
  private get _activePluginId(): string | null {
    const activeSection = this.schemas.find(s => s && s.id === this.activeSectionId);
    return activeSection ? pluginIdFromSection(activeSection.id) : null;
  }

  async save() {
    const pluginId = this._activePluginId;
    if (!pluginId) return;
    const ns = store.namespace<ConfigUIState>('config');
    const dirty = ns.get('dirtyFields')[pluginId];
    if (!dirty || Object.keys(dirty).length === 0) return;

    // PATCH only the dirty fields — never echo untouched values back (they
    // may hold env-interpolated secrets the panel never renders).
    const patch: Record<string, any> = {};
    for (const [dotPath, value] of Object.entries(dirty)) {
      setAtDotPath(patch, dotPath, value);
    }

    try {
      const res = await fetch(new URL(`config/values/${pluginId}`, location.href), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error ?? `server error ${res.status}`);
      }
      // Accepted-vs-applied: track revision until observed catches up.
      noteAcceptedRevision(body);
    } catch (err: any) {
      this._flashError(`Failed to save ${pluginId}: ${err.message}`);
      return;
    }

    // Re-baseline display from the desired values we just wrote (raw placeholders).
    const current = { ...ns.get('currentValues') };
    ns.set('initialValues', { ...ns.get('initialValues'), [pluginId]: structuredClone(current[pluginId] ?? {}) });
    const nextDirty = { ...ns.get('dirtyFields') };
    delete nextDirty[pluginId];
    ns.set('dirtyFields', nextDirty);
    this._flashSaved();
  }

  reset() {
    const pluginId = this._activePluginId;
    if (!pluginId) return;
    const ns = store.namespace<ConfigUIState>('config');

    // Revert the active plugin to the server baseline and drop pending edits.
    const initial = ns.get('initialValues')[pluginId];
    if (initial !== undefined) {
      ns.set('currentValues', { ...ns.get('currentValues'), [pluginId]: structuredClone(initial) });
    }
    const dirty = { ...ns.get('dirtyFields') };
    delete dirty[pluginId];
    ns.set('dirtyFields', dirty);
  }

  private _flashSaved() {
    this._flashMsg?.save();
  }

  private _flashError(msg: string) {
    this._flashMsg?.error(msg);
  }

  private _statusFor(p: any): string | undefined {
    let statusStr = 'idle';
    if (p.status === 'active' && p.health?.status === 'ok') {
      statusStr = 'running';
    } else if (p.status === 'failed' || p.health?.status === 'unavailable') {
      statusStr = 'failed';
    } else {
      statusStr = 'warn';
    }
    return statusStr;
  }

  private get _treeData(): TreeNode[] {
    const rawSchemaTree = buildConfigTree(this.schemas);
    const { filteredNodes } = filterConfigTree(rawSchemaTree, this.searchQuery);

    // Schema pages are shared across systems (single schema surface); they get
    // stamped with the owning systemId when nested under a system's plugin.
    const pagesByPlugin = new Map<string, TreeNode[]>();
    for (const group of filteredNodes) {
      for (const child of group.children ?? []) {
        const pluginId = pluginIdFromSection(child.id);
        const pages = pagesByPlugin.get(pluginId) ?? [];
        pages.push({
          id: `sec-${child.id}`,
          label: child.label,
          icon: 'wrench' as const,
          data: child.section ? { section: child.section } : undefined,
        });
        pagesByPlugin.set(pluginId, pages);
      }
    }

    // Tree roots at each observed systemId; plugins + pages nest beneath.
    return this.systems.map(sys => {
      const systemId = sys.systemId;
      const plugins: any[] = sys.plugins ?? [];
      return {
        id: `system-${systemId}`,
        label: systemId,
        icon: 'settings' as const,
        badge: plugins.length,
        data: { systemId },
        children: plugins.map(p => ({
          id: `plugin-${p.id}`,
          label: p.id,
          icon: 'file-text' as const,
          status: this._statusFor(p),
          badge:
            pluginSyncStatus(p) === 'synced'
              ? undefined
              : pluginSyncStatus(p) === 'degraded'
              ? 'degraded'
              : 'pending',
          data: { systemId, plugin: p },
          children: (pagesByPlugin.get(p.id) ?? []).map(page => ({
            ...page,
            data: { systemId, ...(page.data ?? {}) },
          })),
        })),
      };
    });
  }

  private _onNodeSelect(e: CustomEvent) {
    const node = e.detail.node;
    if (node && node.id) {
      this.selectedNodeId = node.id;
      const systemId = node.data?.systemId;
      if (systemId) {
        store.namespace<ConfigUIState>('config').set('activeSystemId', systemId);
      }
      if (node.id.startsWith('sec-')) {
        this.activeSectionId = node.id.slice(4);
      }
    }
  }

  private _onSearchInput = (e: Event) => {
    this.searchQuery = (e.target as HTMLInputElement).value;
  };

  private _onInputChange(e: any) {
    if (e.detail && 'value' in e.detail) {
      store.namespace<ConfigUIState>('config').set('addInputPath', e.detail.value);
    }
  }

  private async _onLoadSubmit(e: Event) {
    e.preventDefault();
    const ns = store.namespace<ConfigUIState>('config');
    const path = ns.get('addInputPath').trim();
    if (!path) return;

    ns.set('isSubmitting', true);
    ns.set('error', null);

    try {
      const res = await fetch(`/config/plugins/add?systemId=${encodeURIComponent(this.activeSystemId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modulePath: path }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        noteAcceptedRevision(data);
        ns.set('addInputPath', '');
        await refreshConfigPlugins();
        // Optional id once applied; until then list may lag observed.
        const newId = data?.details?.id;
        if (newId) {
          this.selectedNodeId = `plugin-${newId}`;
        }
      } else {
        ns.set('error', `Failed to load plugin: ${res.status} ${data?.error ?? JSON.stringify(data)}`);
      }
    } catch (err) {
      ns.set('error', String(err));
    } finally {
      ns.set('isSubmitting', false);
    }
  }

  private async _onUnload(id: string) {
    const ns = store.namespace<ConfigUIState>('config');
    ns.set('error', null);
    try {
      const res = await fetch(`/config/plugins/remove?systemId=${encodeURIComponent(this.activeSystemId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginId: id }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        noteAcceptedRevision(data);
        await refreshConfigPlugins();
      } else {
        ns.set('error', `Failed to unload plugin: ${res.status} ${data?.error ?? ''}`);
      }
    } catch (err) {
      ns.set('error', String(err));
    }
  }

  private async _onReload(id: string) {
    const ns = store.namespace<ConfigUIState>('config');
    ns.set('error', null);
    try {
      const res = await fetch(`/config/plugins/reload?systemId=${encodeURIComponent(this.activeSystemId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginId: id }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        noteAcceptedRevision(data);
        await refreshConfigPlugins();
      } else {
        ns.set('error', `Failed to reload plugin: ${res.status} ${data?.error ?? ''}`);
      }
    } catch (err) {
      ns.set('error', String(err));
    }
  }

  private _getPluginKvItems(p: any) {
    const items = [
      { key: 'id', label: 'Plugin ID', value: p.id },
      { key: 'version', label: 'Version', value: p.version },
      { key: 'status', label: 'Load Status', value: p.status },
      { key: 'modulePath', label: 'Module Path', value: p.modulePath || '(built-in)' },
    ];
    if (p.health) {
      items.push({ key: 'healthStatus', label: 'Health Status', value: p.health.status });
      if (p.health.detail) {
        items.push({ key: 'healthDetail', label: 'Health Detail', value: p.health.detail });
      }
    }
    return items;
  }

  override render() {
    const plugins: any[] = this.activeSystem?.plugins ?? normalizeArray(this._pluginsStore.value);
    const schemas = this.schemas;
    const loading = this._loadingStore.value as boolean;
    const error = this._errorStore.value as string | null;
    const addInputPath = (this._addInputPathStore.value as string) || '';
    const isSubmitting = this._isSubmittingStore.value as boolean;
    const converging = isConfigConverging({
      pendingRevision: this._pendingRevisionStore.value as string | null,
      observedRevision: this._observedRevisionStore.value as string | null,
      appliedRevision: this._appliedRevisionStore.value as string | null,
    });
    const sync = configSyncStatus({
      pendingRevision: this._pendingRevisionStore.value as string | null,
      observedRevision: this._observedRevisionStore.value as string | null,
      appliedRevision: this._appliedRevisionStore.value as string | null,
    }, plugins);

    let selectedPlugin = plugins.find(p => p && `plugin-${p.id}` === this.selectedNodeId);

    const isSectionSelected = !!this.selectedNodeId && this.selectedNodeId.startsWith('sec-');
    const isLoadSelected = this.selectedNodeId === 'load-plugin';

    const activeSection = schemas.find(s => s && s.id === this.activeSectionId);
    const activePluginId = activeSection ? pluginIdFromSection(activeSection.id) : null;
    const hasDirtyFields = activePluginId
      ? Object.keys(((this._dirtyStore.value as Record<string, Record<string, unknown>>) ?? {})[activePluginId] ?? {}).length > 0
      : false;
    const activeTitle = isLoadSelected
      ? 'Load New Plugin'
      : (selectedPlugin ? selectedPlugin.id : (activeSection ? `${activeSection.tab} / ${activeSection.title}` : 'Overview'));

    return html`
      <r-panel elevation="1" style="height: 100%; display: flex; flex-direction: column;">
        <r-toolbar slot="header-container">
          <div class="ws-header-title">
            <span class="ws-title-base">Configuration</span>
            ${activeTitle ? html`
              <span class="ws-title-sep">/</span>
              <span class="ws-title-active">${activeTitle}</span>
            ` : nothing}
          </div>
          <div slot="actions" class="config-actions">
            ${sync.status === 'synced'
              ? html`<span class="converge-badge synced" title="Desired revision matches applied revision">Synced</span>`
              : html`<span
                    class="converge-badge ${sync.status}"
                    title="${sync.status === 'degraded'
                      ? 'A plugin failed or is unavailable, blocking convergence'
                      : 'Desired accepted; waiting for node-control to apply'}">${sync.label}</span>`}
            <r-flash-message id="flash-msg"></r-flash-message>
            ${isSectionSelected ? html`
              <button type="button" class="btn-reset" ?disabled=${!hasDirtyFields || converging} @click=${this.reset}>Reset</button>
              <button type="button" class="btn-save" ?disabled=${!hasDirtyFields || converging} @click=${this.save}>Save</button>
            ` : html`
              <button type="button" class="btn-reset" ?disabled=${loading} @click=${() => (this.selectedNodeId = 'load-plugin')} title="Load a new plugin">
                <r-icon name="plus" size="sm"></r-icon>
                Load New Plugin
              </button>
            `}
          </div>
        </r-toolbar>

        <div class="ws-body">
          <aside class="ws-sidebar">
            <div class="config-search-box">
              <input
                type="text"
                placeholder="Search parameters..."
                .value=${this.searchQuery}
                @input=${this._onSearchInput}
              />
            </div>
            <div class="ws-sidebar-tree">
              <r-tree
                .data=${this._treeData}
                .selectedId=${this.selectedNodeId}
                @node-select=${this._onNodeSelect}
              ></r-tree>
            </div>
          </aside>

          <main class="ws-main">
            ${error ? html`<div style="padding: 1.5rem 1.5rem 0 1.5rem;"><div class="error-banner">${error}</div></div>` : ''}
            ${isLoadSelected
              ? this._renderLoadForm(addInputPath, isSubmitting)
              : isSectionSelected && activeSection
              ? html`
                  <div class="config-section-container">
                    ${this.schemas.map(section => this._renderSection(section))}
                  </div>
                `
              : selectedPlugin
              ? this._renderPluginDetails(selectedPlugin, loading)
              : html`<div style="padding: 3rem; text-align: center; color: var(--text-dim);">Select a node from the sidebar.</div>`
            }
          </main>
        </div>
      </r-panel>
    `;
  }

  private _renderLoadForm(addInputPath: string, isSubmitting: boolean) {
    return html`
      <div class="add-form-wrap">
        <div class="add-form-header">
          <h2 class="add-form-title">Load Runtime Plugin</h2>
          <p class="add-form-subtitle">Register and activate a plugin at runtime by providing its module path.</p>
        </div>
        <form class="add-form" @submit=${this._onLoadSubmit}>
          <div class="add-input">
            <r-input
              type="text"
              label="Plugin Module Path"
              placeholder="e.g. ./src/plugins/sample/index.ts"
              .value=${addInputPath}
              ?disabled=${isSubmitting}
              @change=${this._onInputChange}
            ></r-input>
          </div>
          <r-button
            type="button"
            variant="primary"
            ?disabled=${!addInputPath.trim() || isSubmitting}
            ?loading=${isSubmitting}
            @click=${this._onLoadSubmit}
          >
            Load Plugin
          </r-button>
          <input type="submit" style="display: none;" />
        </form>
      </div>
    `;
  }

  private _renderPluginDetails(selectedPlugin: any, loading: boolean) {
    return html`
      <div class="plugin-details-wrap">
        <div class="plugin-header-card">
          <div class="plugin-title-area">
            <div class="plugin-title-row">
              <h2 class="plugin-title">${selectedPlugin.id}</h2>
              <span class="plugin-version-badge">v${selectedPlugin.version}</span>
            </div>
            <p class="plugin-subtitle-path">${selectedPlugin.modulePath || 'Built-in plugin'}</p>
          </div>
          <div class="plugin-badges">
            ${selectedPlugin.status === 'active'
              ? html`<r-badge status="running">active</r-badge>`
              : selectedPlugin.status === 'loading'
              ? html`<r-badge status="pending">loading</r-badge>`
              : selectedPlugin.status === 'deactivating'
              ? html`<r-badge status="blocked">deactivating</r-badge>`
              : html`<r-badge status="failed" title="${selectedPlugin.error ? String(selectedPlugin.error) : 'failed'}">failed</r-badge>`}

            ${!selectedPlugin.health
              ? html`<r-badge status="pending">unknown</r-badge>`
              : selectedPlugin.health.status === 'ok'
              ? html`<r-badge status="completed">ok</r-badge>`
              : selectedPlugin.health.status === 'degraded'
              ? html`<r-badge status="blocked" title="${selectedPlugin.health.detail || 'degraded'}">degraded</r-badge>`
              : html`<r-badge status="failed" title="${selectedPlugin.health.detail || 'unavailable'}">unavailable</r-badge>`}
          </div>
        </div>

        ${selectedPlugin.health?.detail ? html`
          <div class="health-detail-banner ${selectedPlugin.health.status === 'degraded' ? 'degraded' : 'failed'}">
            <strong>Health Issue:</strong>
            <div>${selectedPlugin.health.detail}</div>
          </div>
        ` : ''}

        <r-card>
          <div slot="header">Plugin Metadata</div>
          <r-kv-list .items=${this._getPluginKvItems(selectedPlugin)}></r-kv-list>
        </r-card>

        <div class="plugin-actions-row">
          <r-button
            variant="secondary"
            ?disabled=${!selectedPlugin.modulePath || loading}
            @click=${() => this._onReload(selectedPlugin.id)}
          >
            Reload Plugin
          </r-button>
          <r-button
            variant="danger"
            ?disabled=${loading}
            title=${CORE_PLUGIN_IDS.includes(selectedPlugin.id)
              ? 'Warning: unloading a core plugin may break admin/UI until restored in desired config'
              : ''}
            @click=${() => {
              if (CORE_PLUGIN_IDS.includes(selectedPlugin.id)) {
                const ok = confirm(
                  `Unload core plugin "${selectedPlugin.id}"? This may break admin/UI until the desired config is restored.`,
                )
                if (!ok) return
              }
              this._onUnload(selectedPlugin.id)
            }}
          >
            Unload Plugin
          </r-button>
        </div>
      </div>
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
}
