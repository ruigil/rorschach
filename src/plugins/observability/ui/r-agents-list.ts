import { css, customElement, html, RorschachBase, StoreController, send } from '@rorschach/webkit';

export type AgentInfo = {
  mode: string;
  displayName: string;
  shortDesc: string;
  userVisible?: boolean;
  role?: string;
  model?: string;
};

@customElement('r-agents-list')
export class RAgentsList extends RorschachBase {
  private _observeAgents = new StoreController(this, ['observe', 'agents']);
  private _shellAgents = new StoreController(this, ['shell', 'agents']);

  static override styles = css`
    :host {
      display: block;
      height: 100%;
      width: 100%;
      overflow-y: auto;
      padding: 0.75rem;
      box-sizing: border-box;
    }

    :host::-webkit-scrollbar { width: 3px; }
    :host::-webkit-scrollbar-track { background: transparent; }
    :host::-webkit-scrollbar-thumb { background: var(--border-mid); border-radius: 2px; }

    .agents-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 0.75rem;
    }

    .agent-card {
      background: var(--bg-surface, rgba(255, 255, 255, 0.03));
      border: 1px solid var(--border-mid, rgba(255, 255, 255, 0.1));
      border-radius: 6px;
      padding: 0.85rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      transition: border-color 0.15s, background-color 0.15s;
    }

    .agent-card:hover {
      border-color: var(--border-focus, #5c9eff);
      background: var(--bg-hover, rgba(255, 255, 255, 0.05));
    }

    .agent-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .agent-title {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text, #fff);
      font-family: var(--font-ui);
    }

    .agent-mode {
      font-size: 0.65rem;
      font-family: var(--font-mono);
      color: var(--text-dim, #888);
      background: var(--bg-subtle, rgba(255, 255, 255, 0.06));
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
    }

    .agent-desc {
      font-size: 0.75rem;
      color: var(--text-mid, #ccc);
      line-height: 1.35;
    }

    .agent-meta {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: auto;
      padding-top: 0.35rem;
      border-top: 1px dashed var(--border-subtle, rgba(255, 255, 255, 0.08));
    }

    .agent-badge {
      font-size: 0.6rem;
      font-family: var(--font-mono);
      padding: 0.1rem 0.35rem;
      border-radius: 3px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .badge-visible {
      background: rgba(46, 204, 113, 0.15);
      color: #2ecc71;
      border: 1px solid rgba(46, 204, 113, 0.3);
    }

    .badge-internal {
      background: rgba(241, 196, 15, 0.15);
      color: #f1c40f;
      border: 1px solid rgba(241, 196, 15, 0.3);
    }

    .agent-model {
      font-size: 0.65rem;
      font-family: var(--font-mono);
      color: var(--text-dim, #888);
      margin-left: auto;
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    send({ type: 'cognitive.agents.request' });
  }

  override render() {
    const agents: AgentInfo[] = (this._observeAgents.value && this._observeAgents.value.length > 0)
      ? this._observeAgents.value
      : (this._shellAgents.value || []);

    if (agents.length === 0) {
      return html`<r-empty-state variant="panel" text="no agents registered"></r-empty-state>`;
    }

    return html`
      <div class="agents-grid">
        ${agents.map(agent => html`
          <div class="agent-card">
            <div class="agent-header">
              <span class="agent-title">${agent.displayName || agent.mode}</span>
              <span class="agent-mode">${agent.mode}</span>
            </div>
            <div class="agent-desc">${agent.shortDesc || agent.role || 'No description available'}</div>
            <div class="agent-meta">
              <span class="agent-badge ${agent.userVisible !== false ? 'badge-visible' : 'badge-internal'}">
                ${agent.userVisible !== false ? 'user-facing' : 'internal'}
              </span>
              ${agent.model ? html`<span class="agent-model">${agent.model}</span>` : ''}
            </div>
          </div>
        `)}
      </div>
    `;
  }
}
