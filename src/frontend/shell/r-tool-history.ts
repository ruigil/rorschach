import {
  css,
  customElement,
  html,
  property,
  RorschachBase
} from '@rorschach/webkit';

const formatToolName = (toolName: string): string => {
  if (!toolName) return '';
  return toolName
    .split(/[_-]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

@customElement('r-tool-history')
export class RToolHistory extends RorschachBase {
  @property({ type: Array }) tools: Array<string | { name: string; arguments?: string }> = [];
  @property({ type: Boolean }) active = false;

  static override styles = css`
    :host {
      display: block;
      margin-bottom: 8px;
    }

    .tools-details {
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      font-size: 0.78rem;
    }

    .tools-summary {
      padding: 5px 10px;
      cursor: pointer;
      color: var(--text-dim);
      background: var(--surface-2);
      user-select: none;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .tools-summary:hover {
      background: var(--hover-bg);
    }

    .tools-summary::-webkit-details-marker {
      display: none;
    }

    .tools-summary::before {
      content: '▶';
      font-size: 0.55em;
      opacity: 0.6;
      transition: transform 0.15s ease;
    }

    .tools-details[open] .tools-summary::before {
      transform: rotate(90deg);
    }

    .tools-details[open] .tools-summary {
      border-bottom: 1px solid var(--border);
    }

    .tools-list {
      margin: 0;
      padding: 8px 12px;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 6px;
      color: var(--text-dim);
      background: transparent;
    }

    .tool-item {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .tool-args {
      font-family: var(--font-mono, monospace);
      font-size: 0.72rem;
      color: var(--text-dim);
      opacity: 0.85;
      background: var(--surface-3, rgba(255, 255, 255, 0.05));
      padding: 1px 6px;
      border-radius: 4px;
      max-width: 320px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .status-icon {
      font-size: 0.85rem;
      width: 14px;
      display: inline-flex;
      justify-content: center;
    }

    .status-icon.active {
      color: var(--accent);
      animation: spin 1.5s linear infinite;
    }

    .status-icon.done {
      color: var(--text-dim);
      opacity: 0.8;
    }

    .header-spinner {
      font-size: 0.7rem;
      color: var(--accent);
      animation: spin 1.5s linear infinite;
      display: inline-block;
    }

    .header-icon.done {
      width: 14px;
      height: 14px;
      opacity: 0.8;
      display: inline-flex;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    @keyframes tools-glow {
      0%, 100% { color: var(--text-dim); text-shadow: none; }
      50% { color: var(--accent-bright); text-shadow: 0 0 8px var(--accent-glow); }
    }

    .tools-streaming .tools-summary {
      color: var(--accent);
      animation: tools-glow 1.8s ease-in-out infinite;
    }
  `;

  override render() {
    if (!this.tools || this.tools.length === 0) return html``;

    let headerText = '';
    if (this.active) {
      headerText = 'Using tools...';
    } else {
      headerText = `${this.tools.length} tool(s) used`;
    }

    return html`
      <details class="tools-details ${this.active ? 'tools-streaming' : ''}">
        <summary class="tools-summary">
          <r-icon class="header-icon done" name="wrench"></r-icon>
          <span class="header-text">${headerText}</span>
        </summary>
        <ul class="tools-list">
          ${this.tools.map((item, idx) => {
            const isLast = idx === this.tools.length - 1;
            const isActive = isLast && this.active;
            const toolName = typeof item === 'string' ? item : item.name;
            const rawArgs = typeof item === 'object' ? item.arguments : undefined;
            const argsSnippet = rawArgs ? (rawArgs.length > 80 ? rawArgs.slice(0, 80) + '…' : rawArgs) : '';

            return html`
              <li class="tool-item">
                <span class="status-icon ${isActive ? 'active' : 'done'}">
                  ${isActive ? '⚙' : '✓'}
                </span>
                <span class="tool-name">${formatToolName(toolName)}</span>
                ${argsSnippet ? html`<code class="tool-args">${argsSnippet}</code>` : ''}
              </li>
            `;
          })}
        </ul>
      </details>
    `;
  }
}
