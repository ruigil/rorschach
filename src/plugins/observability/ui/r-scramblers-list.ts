import { css, customElement, html, RorschachBase, StoreController, send } from '@rorschach/webkit';

@customElement('r-scramblers-list')
export class RScramblersList extends RorschachBase {
  private _scramblers = new StoreController(this, ['observe', 'scramblers']);

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

    .scramblers-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 0.75rem;
    }

    .scrambler-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius, 8px);
      padding: 0.85rem;
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
      transition: border-color 0.15s, background-color 0.15s;
    }

    .scrambler-card:hover {
      border-color: var(--border-mid);
      background: var(--surface-2);
    }

    .scrambler-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }

    .scrambler-title {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text);
      font-family: var(--font-ui);
      word-break: break-all;
    }

    .scrambler-kind {
      font-size: 0.65rem;
      font-family: var(--font-mono);
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 600;
      flex-shrink: 0;
    }

    .kind-leaf {
      background: rgba(57, 232, 160, 0.08);
      color: var(--green);
      border: 1px solid rgba(57, 232, 160, 0.2);
    }

    .kind-reasoner {
      background: var(--trace-llm-bg);
      color: var(--text-mid);
      border: 1px solid var(--trace-llm-border);
    }

    .kind-graph {
      background: var(--trace-tool-bg);
      color: var(--warn);
      border: 1px solid var(--trace-tool-border);
    }

    .kind-operator {
      background: var(--accent-dim);
      color: var(--accent);
      border: 1px solid var(--accent-glow);
    }

    .scrambler-desc {
      font-size: 0.75rem;
      color: var(--text-mid);
      line-height: 1.35;
    }

    .scrambler-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.4rem;
      margin-top: 0.2rem;
    }

    .meta-tag {
      font-size: 0.6rem;
      font-family: var(--font-mono);
      background: var(--surface-2);
      color: var(--text-dim);
      padding: 0.1rem 0.35rem;
      border-radius: 3px;
      border: 1px solid var(--border);
    }

    .badge-pending {
      background: rgba(196, 132, 58, 0.08);
      color: var(--warn);
      border: 1px solid rgba(196, 132, 58, 0.2);
    }

    .schema-section {
      margin-top: auto;
      padding-top: 0.5rem;
      border-top: 1px dashed var(--border);
    }

    .schema-details {
      font-size: 0.7rem;
      color: var(--text-dim);
    }

    .schema-summary {
      font-size: 0.7rem;
      font-weight: 500;
      color: var(--text-dim);
      cursor: pointer;
      user-select: none;
      padding: 0.2rem 0;
      outline: none;
      transition: color 0.15s;
    }

    .schema-summary:hover {
      color: var(--text-mid);
    }

    .schema-group {
      margin-top: 0.4rem;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .schema-label {
      font-weight: 600;
      color: var(--text-mid);
    }

    .schema-code {
      font-family: var(--font-mono);
      font-size: 0.65rem;
      background: var(--pre-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 0.4rem;
      overflow-x: auto;
      max-height: 120px;
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--text);
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    send({ type: 'scramblers.list.request' });
  }

  override render() {
    const scramblersMap = this._scramblers.value || {};
    const scramblersList = Object.values(scramblersMap)
      .map((scr: any, index) => {
        if (!scr || typeof scr !== 'object') return null;
        return {
          urn: scr.urn || `unknown-${index}`,
          kind: scr.kind || 'leaf',
          description: scr.description || '',
          schema: scr.schema || {},
          tags: scr.tags || [],
          yieldsPending: !!scr.yieldsPending,
          meta: scr.meta
        };
      })
      .filter((scr): scr is NonNullable<typeof scr> => scr !== null)
      .sort((a, b) => a.urn.localeCompare(b.urn));

    if (scramblersList.length === 0) {
      return html`<r-empty-state variant="panel" text="no scramblers registered"></r-empty-state>`;
    }

    return html`
      <div class="scramblers-grid">
        ${scramblersList.map((scr: any) => {
          const kindClass = `kind-${scr.kind}`;
          const hasInput = scr.schema?.inputSchema && Object.keys(scr.schema.inputSchema).length > 0;
          const hasOutput = scr.schema?.outputSchema && Object.keys(scr.schema.outputSchema).length > 0;
          const hasSchema = hasInput || hasOutput;

          return html`
            <div class="scrambler-card">
              <div class="scrambler-header">
                <span class="scrambler-title">${scr.urn}</span>
                <span class="scrambler-kind ${kindClass}">${scr.kind}</span>
              </div>
              <div class="scrambler-desc">${scr.description || 'No description available'}</div>
              
              <div class="scrambler-meta">
                ${scr.yieldsPending ? html`
                  <span class="meta-tag badge-pending">yields-pending</span>
                ` : ''}
                ${(scr.tags || []).map((tag: string) => html`
                  <span class="meta-tag">${tag}</span>
                `)}
              </div>

              ${hasSchema ? html`
                <div class="schema-section">
                  <details class="schema-details">
                    <summary class="schema-summary">Schema Details</summary>
                    ${hasInput ? html`
                      <div class="schema-group">
                        <span class="schema-label">Input Schema:</span>
                        <pre class="schema-code">${JSON.stringify(scr.schema.inputSchema, null, 2)}</pre>
                      </div>
                    ` : ''}
                    ${hasOutput ? html`
                      <div class="schema-group">
                        <span class="schema-label">Output Schema:</span>
                        <pre class="schema-code">${JSON.stringify(scr.schema.outputSchema, null, 2)}</pre>
                      </div>
                    ` : ''}
                  </details>
                </div>
              ` : ''}
            </div>
          `;
        })}
      </div>
    `;
  }
}
