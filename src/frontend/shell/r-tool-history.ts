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
  @property({ type: Array }) tools: string[] = [];
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
  `;

  override render() {
    if (!this.tools || this.tools.length === 0) return html``;

    const lastTool = this.tools[this.tools.length - 1];
    let headerText = '';
    if (this.active) {
      headerText = lastTool ? `${formatToolName(lastTool)}...` : 'Thinking...';
    } else {
      headerText = `${this.tools.length} ${this.tools.length === 1 ? 'tool' : 'tools'} used`;
    }

    return html`
      <details class="tools-details" ?open=${this.active}>
        <summary class="tools-summary">
          ${!this.active ? html`<r-icon class="header-icon done" name="wrench"></r-icon>` : ''}
          <span class="header-text">${headerText}</span>
          ${this.active ? html`<span class="header-spinner">⚙</span>` : ''}
        </summary>
        <ul class="tools-list">
          ${this.tools.map((tool, idx) => {
            const isLast = idx === this.tools.length - 1;
            const isActive = isLast && this.active;
            return html`
              <li class="tool-item">
                <span class="status-icon ${isActive ? 'active' : 'done'}">
                  ${isActive ? '⚙' : '✓'}
                </span>
                <span class="tool-name">${formatToolName(tool)}</span>
              </li>
            `;
          })}
        </ul>
      </details>
    `;
  }
}
