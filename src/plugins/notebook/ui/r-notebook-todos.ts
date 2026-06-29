import { html } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import { RorschachBase } from '@rorschach/frontend/webkit/base.js'

@customElement('r-notebook-todos')
export class RNotebookTodos extends RorschachBase {
  @state() private _todos: any[] = []
  @state() private _loading = true
  @state() private _error: string | null = null

  override createRenderRoot() {
    return this // Light DOM
  }

  override connectedCallback() {
    super.connectedCallback()
    this._fetchTodos()
  }

  private async _fetchTodos() {
    try {
      this._loading = true
      const res = await fetch('/notebook/todos')
      if (!res.ok) throw new Error(await res.text())
      this._todos = await res.json()
      this._error = null
    } catch (e: any) {
      this._error = e.message || 'Failed to load todos'
    } finally {
      this._loading = false
    }
  }

  override render() {
    if (this._loading) {
      return html`<div class="nb-loading-container">Loading todos...</div>`
    }
    if (this._error) {
      return html`<div class="nb-error-container">${this._error}</div>`
    }
    if (this._todos.length === 0) {
      return html`
        <div class="nb-empty-container">
          <r-icon name="file-text" style="opacity: 0.3; width: 32px; height: 32px; margin-bottom: 8px;"></r-icon>
          <div>No todos found.</div>
        </div>
      `
    }

    return html`
      <div class="nb-todos-container">
        <div class="nb-section-header">
          <span class="nb-title">Latest 10 Todos</span>
          <button class="nb-refresh-btn" @click=${this._fetchTodos} title="Refresh">
            <r-icon name="activity" style="width: 14px; height: 14px;"></r-icon>
          </button>
        </div>
        <div class="nb-todos-list">
          ${this._todos.map(t => html`
            <div class="nb-todo-item ${t.done ? 'done' : ''}">
              <div class="nb-todo-indicator">
                ${t.done 
                  ? html`<span class="nb-indicator-dot done">✓</span>`
                  : html`<span class="nb-indicator-dot pending">●</span>`
                }
              </div>
              <div class="nb-todo-details">
                <div class="nb-todo-text">${t.text}</div>
                <div class="nb-todo-metadata">
                  ${t.dueDate ? html`<span class="nb-meta-tag due">due: ${t.dueDate}</span>` : ''}
                  ${t.recurrence ? html`<span class="nb-meta-tag recur">recurring: ${t.recurrence}</span>` : ''}
                </div>
              </div>
            </div>
          `)}
        </div>
      </div>
    `
  }
}
