import {
  css,
  customElement,
  html,
  RorschachBase,
  sharedStyles,
  state,
  store,
  StoreController,
  type ListItem,
  send
} from '@rorschach/webkit';

type TerminalHistoryEntry = {
  type: 'input' | 'output';
  text: string;
  cwd?: string;
  error?: boolean;
};

@customElement('r-code-workspace')
export class RCodeWorkspace extends RorschachBase {
  private _currentDocArtifact = new StoreController(this, ['code', 'currentDocArtifact']);
  private _lastBashResponse = new StoreController(this, ['code', 'lastBashResponse']);
  private _currentCwd = new StoreController(this, ['code', 'cwd']);
  private _lastAutocompleteResponse = new StoreController(this, ['code', 'lastAutocompleteResponse']);

  @state() private _activeTab: 'bash' | 'docs' = 'bash';
  @state() private _pages: ListItem[] = [];
  @state() private _selectedPage: string | null = null;
  @state() private _loading = false;

  // Terminal state
  @state() private _terminalHistory: TerminalHistoryEntry[] = [];
  @state() private _commandInput = '';
  @state() private _runningCommand = false;

  private _commandHistory: string[] = [];
  private _historyIndex = 0;
  private _pendingCmdId: string | null = null;

  // Autocomplete state
  private _pendingAutocompleteCmdId: string | null = null;
  private _autocompleteLastWord = '';
  private _pendingAutocompletePrefix = '';
  private _pendingAutocompleteDir = '';

  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        height: 100%;
        width: 100%;
      }
      .terminal-container {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: var(--bg);
        color: var(--text);
        font-family: var(--font-mono, monospace);
        font-size: 0.8rem;
        overflow: hidden;
      }
      .terminal-output {
        flex: 1;
        overflow-y: auto;
        padding: 0.75rem;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .terminal-welcome {
        color: var(--text-dim);
        border-bottom: 1px dashed var(--border);
        padding-bottom: 4px;
        margin-bottom: 4px;
        white-space: pre-wrap;
      }
      .terminal-line {
        white-space: nowrap;
        word-break: break-all;
      }
      .input-line {
        display: flex;
        align-items: center;
        gap: 8px;
        white-space: nowrap;
      }
      .prompt {
        color: var(--accent);
        font-weight: bold;
        user-select: none;
      }
      .output-text {
        margin: 0;
        font-family: inherit;
        font-size: inherit;
        white-space: pre-wrap;
        color: #d0d7de;
        background: transparent;
        border: none;
        padding: 0;
      }
      .error-line .output-text {
        color: var(--error, #ff7b72);
      }
      .terminal-input {
        flex: 1;
        background: transparent;
        border: none;
        outline: none;
        color: #ffffff;
        font-family: inherit;
        font-size: inherit;
        padding: 0;
        margin: 0;
        caret-shape: block;
        caret-color: var(--accent);
      }
      .terminal-input:disabled {
        color: var(--text-dim);
      }
      .doc-layout {
        display: flex;
        height: 100%;
        width: 100%;
      }
      .doc-sidebar {
        width: 250px;
        border-right: 1px solid var(--border);
        overflow-y: auto;
        padding: 10px;
        flex-shrink: 0;
        background: var(--surface-1);
      }
      .doc-content {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        background: var(--surface-2);
        display: flex;
        flex-direction: column;
      }
      iframe {
        width: 100%;
        height: 100%;
        border: none;
        background: transparent;
      }
    `
  ];

  get displayCwd() {
    const cwd = (this._currentCwd.value as string) || '/rorschach';
    if (cwd === '/rorschach') return '~';
    if (cwd.startsWith('/rorschach/')) {
      return '~' + cwd.slice('/rorschach'.length);
    }
    return cwd;
  }

  override firstUpdated() {
    this._fetchManifest();
    this._scrollToBottom();
  }

  override updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);

    const storeDoc = this._currentDocArtifact.value as string | null;
    if (storeDoc && storeDoc !== this._selectedPage) {
      this._selectedPage = storeDoc;
    }

    const lastResponse = this._lastBashResponse.value as any;
    if (lastResponse && lastResponse.cmdId === this._pendingCmdId) {
      this._pendingCmdId = null;
      this._runningCommand = false;

      let outputText = '';
      let isError = false;
      if (lastResponse.error) {
        outputText = lastResponse.error;
        isError = true;
      } else {
        const out = lastResponse.stdout || '';
        const err = lastResponse.stderr || '';
        if (out && err) {
          outputText = `${out}\nSTDERR:\n${err}`;
        } else {
          outputText = out || err || '(no output)';
        }
        if (lastResponse.exitCode !== 0) {
          outputText += `\nExit code: ${lastResponse.exitCode}`;
          isError = true;
        }
      }

      this._terminalHistory = [
        ...this._terminalHistory,
        { type: 'output', text: outputText, error: isError }
      ];
      this._commandInput = '';

      this._scrollToBottom();
    }

    const autoResponse = this._lastAutocompleteResponse.value as any;
    if (autoResponse && autoResponse.cmdId === this._pendingAutocompleteCmdId) {
      this._pendingAutocompleteCmdId = null;

      const files = autoResponse.files || [];
      const prefix = this._pendingAutocompletePrefix || '';
      const dir = this._pendingAutocompleteDir || '';

      const matches = files
        .filter((f: string) => f.startsWith(prefix))
        .map((f: string) => {
          if (f.endsWith('/') || f.endsWith('//')) return f;
          if (f.endsWith('*') || f.endsWith('@') || f.endsWith('=') || f.endsWith('|') || f.endsWith('>')) {
            return f.slice(0, -1);
          }
          return f;
        });
      if (matches.length === 1) {
        const match = matches[0];
        const lastWord = this._autocompleteLastWord || '';

        const inputVal = this._commandInput;
        const index = inputVal.lastIndexOf(lastWord);
        if (index !== -1) {
          const isDir = match.endsWith('/');
          const completedWord = dir === '.' ? match : dir + match;
          const replacement = completedWord + (isDir ? '' : ' ');

          this._commandInput = inputVal.slice(0, index) + replacement;
          this._scrollToBottom();
        }
      } else if (matches.length > 1) {
        let common = prefix;
        let index = prefix.length;
        while (true) {
          const char = matches[0][index];
          if (!char) break;
          const allMatch = matches.every((m: string) => m[index] === char);
          if (allMatch) {
            common += char;
            index++;
          } else {
            break;
          }
        }
        if (common !== prefix) {
          const lastWord = this._autocompleteLastWord || '';
          const inputVal = this._commandInput;
          const wordIndex = inputVal.lastIndexOf(lastWord);
          if (wordIndex !== -1) {
            const completedWord = dir === '.' ? common : dir + common;
            this._commandInput = inputVal.slice(0, wordIndex) + completedWord;
            this._scrollToBottom();
          }
        } else {
          const optionsText = matches.join('  ');
          this._terminalHistory = [
            ...this._terminalHistory,
            { type: 'output', text: optionsText }
          ];
          this._scrollToBottom();
        }
      }
    }
  }

  private async _fetchManifest() {
    this._loading = true;
    try {
      const res = await fetch('/artifacts/manifest.json');
      if (!res.ok) throw new Error('Failed to fetch manifest');
      const data = await res.json();
      if (data && Array.isArray(data.pages)) {
        this._pages = data.pages.map((p: any) => ({
          id: p.filename,
          label: p.title,
          description: p.summary,
          icon: 'file-text' as const,
        }));

        const storeDoc = this._currentDocArtifact.value as string | null;
        if (storeDoc && this._pages.some(p => p.id === storeDoc)) {
          this._selectedPage = storeDoc;
        } else if (this._pages[0]) {
          this._selectedPage = this._pages[0].id;
        }
      }
    } catch (err) {
      console.error('Error fetching documentation manifest:', err);
    } finally {
      this._loading = false;
    }
  }

  private _handleTabChange(e: CustomEvent) {
    this._activeTab = e.detail.tab as 'bash' | 'docs';
    if (this._activeTab === 'bash') {
      this._scrollToBottom();
    }
  }

  private _handlePageSelect(e: CustomEvent) {
    const pageId = e.detail.id;
    this._selectedPage = pageId;
    store.namespace('code').set('currentDocArtifact', pageId);
  }

  private _handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      const command = this._commandInput.trim();
      if (!command) return;

      this._terminalHistory = [
        ...this._terminalHistory,
        { type: 'input', text: command, cwd: this.displayCwd }
      ];
      this._commandHistory.push(command);
      this._historyIndex = this._commandHistory.length;

      const cmdId = Math.random().toString(36).slice(2);
      this._pendingCmdId = cmdId;
      this._runningCommand = true;

      send({
        type: 'coding.bash.command',
        command,
        cmdId,
        cwd: this._currentCwd.value || '/rorschach',
      });

      this._commandInput = '';
      this._scrollToBottom();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const inputVal = this._commandInput;
      const lastSpace = inputVal.lastIndexOf(' ');
      const lastWord = lastSpace === -1 ? inputVal : inputVal.slice(lastSpace + 1);

      const cmdId = Math.random().toString(36).slice(2);
      this._pendingAutocompleteCmdId = cmdId;
      this._autocompleteLastWord = lastWord;

      let dir = '.';
      let prefix = lastWord;
      const lastSlash = lastWord.lastIndexOf('/');
      if (lastSlash !== -1) {
        dir = lastWord.slice(0, lastSlash + 1);
        prefix = lastWord.slice(lastSlash + 1);
      }

      this._pendingAutocompletePrefix = prefix;
      this._pendingAutocompleteDir = dir;

      send({
        type: 'coding.bash.autocomplete',
        directory: dir,
        cwd: this._currentCwd.value || '/rorschach',
        cmdId,
      });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (this._historyIndex > 0) {
        this._historyIndex--;
        this._commandInput = this._commandHistory[this._historyIndex] || '';
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this._historyIndex < this._commandHistory.length - 1) {
        this._historyIndex++;
        this._commandInput = this._commandHistory[this._historyIndex] || '';
      } else {
        this._historyIndex = this._commandHistory.length;
        this._commandInput = '';
      }
    }
  }

  private _scrollToBottom() {
    setTimeout(() => {
      const output = this.shadowRoot?.getElementById('terminal-output');
      if (output) {
        output.scrollTop = output.scrollHeight;
      }
      const input = this.shadowRoot?.getElementById('terminal-input') as HTMLInputElement | null;
      if (input) {
        input.focus();
      }
    }, 50);
  }

  override render() {
    return html`
      <r-panel elevation="1">
        <r-toolbar slot="header-container">
          <r-tabs @tab-change=${this._handleTabChange}>
            <button ?active=${this._activeTab === 'bash'} data-tab="bash">
              <r-icon name="terminal" size="sm" style="margin-right: 6px;"></r-icon>
              <span>Bash</span>
            </button>
            <button ?active=${this._activeTab === 'docs'} data-tab="docs">
              <r-icon name="file-text" size="sm" style="margin-right: 6px;"></r-icon>
              <span>Documentation</span>
            </button>
          </r-tabs>
        </r-toolbar>

        <div class="flex-column flex-grow-1" style="height: 100%; display: flex; flex-direction: column; overflow: hidden;">
          ${this._activeTab === 'bash' ? html`
            <div class="terminal-container" @click=${() => this._scrollToBottom()}>
              <div class="terminal-output" id="terminal-output">
                <div class="terminal-welcome">Rorschach Bash Terminal Simulation
Connected to mounted project filesystem.
Root folder: /rorschach (read-only)
Workspace folder: /workspace (read-write)</div>
                ${this._terminalHistory.map(entry => html`
                  <div class="terminal-line ${entry.type === 'input' ? 'input-line' : 'output-line'} ${entry.error ? 'error-line' : ''}">
                    ${entry.type === 'input' 
                      ? html`<span class="prompt">workspace:${entry.cwd || '~'}$</span> <span class="input-text">${entry.text}</span>` 
                      : html`<pre class="output-text">${entry.text}</pre>`}
                  </div>
                `)}
                ${this._runningCommand ? html`
                  <div class="terminal-line output-line text-dim text-mono">Running...</div>
                ` : html`
                  <div class="terminal-line input-line">
                    <span class="prompt">workspace:${this.displayCwd}$</span>
                    <input
                      type="text"
                      class="terminal-input"
                      id="terminal-input"
                      .value=${this._commandInput}
                      @input=${(e: Event) => this._commandInput = (e.target as HTMLInputElement).value}
                      @keydown=${this._handleKeyDown}
                      placeholder=""
                    />
                  </div>
                `}
              </div>
            </div>
          ` : html`
            <div class="doc-layout">
              <div class="doc-sidebar">
                <div style="font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim); margin-bottom: 12px; font-weight: 700;">
                  Pages
                </div>
                ${this._loading ? html`<div class="text-dim text-mono" style="font-size: 0.72rem;">Loading...</div>` : html`
                  <r-list
                    .items=${this._pages}
                    selectable
                    .selectedId=${this._selectedPage}
                    @item-select=${this._handlePageSelect}
                    emptyText="No documentation pages generated yet."
                  ></r-list>
                `}
              </div>
              <div class="doc-content">
                ${this._selectedPage ? html`
                  <iframe
                    src="/artifacts/${this._selectedPage}"
                    title="Documentation Page"
                    sandbox="allow-same-origin allow-scripts allow-popups"
                  ></iframe>
                ` : html`
                  <r-empty-state name="file-text" text="Select a page from the sidebar."></r-empty-state>
                `}
              </div>
            </div>
          `}
        </div>
      </r-panel>
    `;
  }
}
