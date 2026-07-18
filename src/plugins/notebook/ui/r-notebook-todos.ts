import {
  css,
  customElement,
  html,
  RorschachBase,
  state,
  StoreController,
  send
} from '@rorschach/webkit';
import type { Todo } from '../types.ts';

@customElement('r-notebook-todos')
export class RNotebookTodos extends RorschachBase {
  private _storeTodos = new StoreController(this, ['notebook', 'todos'])
  private _storeError = new StoreController(this, ['notebook', 'errorMessage'])
  @state() private _loading = true

  private get _todos(): Todo[] { return this._storeTodos.value ?? [] }
  private get _error() { return this._storeError.value }

  static override styles = css`
    :host {
      display: block;
      height: 100%;
      width: 100%;
      font-family: var(--font-ui, 'Space Grotesk', system-ui, sans-serif);
    }
    .nb-todos-container {
      padding: 1rem;
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      height: 100%;
    }
    .nb-loading-container {
      color: var(--text-dim);
      font-size: 0.85rem;
      padding: 2rem;
      text-align: center;
    }
    .nb-error-container {
      color: var(--error);
      background: var(--error-bg);
      border: 1px solid var(--error-border);
      padding: 0.75rem 1rem;
      border-radius: var(--radius, 8px);
      font-size: 0.85rem;
    }
    .todo-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      overflow-y: auto;
      flex: 1;
      margin-top: 1rem;
      padding-right: 4px;
    }
    .todo-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 12px;
      background: var(--surface-2, #0a1820);
      border: 1px solid var(--border);
      border-radius: 6px;
      transition: border-color 0.2s ease, background-color 0.2s ease, transform 0.15s ease;
    }
    .todo-item:hover {
      border-color: var(--border-mid);
      background: var(--surface);
      transform: translateY(-1px);
    }
    .todo-item.done {
      opacity: 0.55;
    }
    .todo-left {
      display: flex;
      align-items: center;
      gap: 10px;
      flex: 1;
      min-width: 0;
      cursor: pointer;
    }
    .todo-checkbox {
      color: var(--text-dim);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: color 0.15s, transform 0.15s;
    }
    .todo-item.done .todo-checkbox {
      color: var(--green);
    }
    .todo-left:hover .todo-checkbox {
      color: var(--accent);
      transform: scale(1.1);
    }
    .todo-content {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 12px;
      flex: 1;
      min-width: 0;
    }
    .todo-label {
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }
    .todo-item.done .todo-label {
      text-decoration: line-through;
      color: var(--text-dim);
    }
    .chip-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-left: auto;
      flex-shrink: 0;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.65rem;
      border: 1px solid var(--border);
      background: var(--surface-3, rgba(255, 255, 255, 0.02));
      color: var(--text-mid);
      font-family: var(--font-mono, monospace);
    }
    .chip.due {
      border-color: var(--warn, #c4843a);
      color: var(--warn, #c4843a);
    }
    .chip.recur {
      border-color: var(--accent, #00c4d4);
      color: var(--accent, #00c4d4);
    }
    .todo-right {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }
    .todo-priority-container {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.72rem;
      color: var(--text-dim);
      font-family: var(--font-mono, monospace);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .priority-circle {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
      transition: box-shadow 0.2s ease;
    }
    .priority-circle.high {
      background-color: var(--error, #e06030);
      box-shadow: 0 0 6px var(--error, #e06030);
    }
    .priority-circle.medium {
      background-color: var(--warn, #c4843a);
      box-shadow: 0 0 6px var(--warn, #c4843a);
    }
    .priority-circle.low {
      background-color: var(--green, #39e8a0);
      box-shadow: 0 0 6px var(--green, #39e8a0);
    }
    .priority-circle.none {
      background-color: var(--border-mid, #1a3548);
    }
    .delete-btn {
      background: transparent;
      border: none;
      color: var(--text-dim);
      cursor: pointer;
      padding: 6px;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s, background-color 0.15s;
    }
    .delete-btn:hover {
      background: var(--error-hover, rgba(224, 96, 48, 0.15));
      color: var(--error, #e06030);
    }
  `;

  override connectedCallback() {
    super.connectedCallback()
    this._fetchTodos()
  }

  override updated() {
    if (this._storeTodos.value !== undefined && this._loading) {
      this._loading = false
    }
  }

  private _fetchTodos() {
    this._loading = true
    send({ type: 'notebook.todos.request' })
  }

  private _toggleComplete(todo: Todo) {
    if (!todo.done) {
      send({ type: 'notebook.todos.complete', id: todo.id })
    }
  }

  private _onDeleteTodo(e: Event, id: string) {
    e.stopPropagation()
    send({ type: 'notebook.todos.delete', id })
  }

  override render() {
    if (this._loading) {
      return html`<div class="nb-loading-container">Loading todos...</div>`
    }
    if (this._error) {
      return html`<div class="nb-error-container">${this._error}</div>`
    }
    if (this._todos.length === 0) {
      return html`<r-empty-state name="file-text" text="No todos found."></r-empty-state>`
    }

    const items = this._todos.map((t) => {
      const chips: any[] = []
      if (t.dueDate) {
        chips.push({ label: `due: ${t.dueDate}`, type: 'due' })
      }
      if (t.recurrence) {
        chips.push({ label: `recurring: ${t.recurrence}`, type: 'recur' })
      }

      return html`
        <div class="todo-item ${t.done ? 'done' : ''}">
          <div class="todo-left" @click=${() => this._toggleComplete(t)}>
            <span class="todo-checkbox">
              <r-icon name=${t.done ? 'check' : 'circle'}></r-icon>
            </span>
            <div class="todo-content">
              <span class="todo-label">${t.text}</span>
              ${chips.length > 0 ? html`
                <div class="chip-list">
                  ${chips.map(chip => html`
                    <span class="chip ${chip.type}">${chip.label}</span>
                  `)}
                </div>
              ` : ''}
            </div>
          </div>
          <div class="todo-right">
            ${t.priority ? html`
              <div class="todo-priority-container" title="Priority: ${t.priority}">
                <span class="todo-priority-text">${t.priority}</span>
                <span class="priority-circle ${t.priority}"></span>
              </div>
            ` : html`
              <div class="todo-priority-container" title="No priority set">
                <span class="priority-circle none"></span>
              </div>
            `}
            <button class="delete-btn" title="Delete Todo" @click=${(e: Event) => this._onDeleteTodo(e, t.id)}>
              <r-icon name="trash"></r-icon>
            </button>
          </div>
        </div>
      `
    })

    return html`
      <div class="nb-todos-container">
        <r-section-header title="Latest 10 Todos"></r-section-header>
        <div class="todo-list">
          ${items}
        </div>
      </div>
    `
  }
}
