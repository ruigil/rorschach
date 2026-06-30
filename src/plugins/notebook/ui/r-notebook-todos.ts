import { html } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import { RorschachBase } from '@rorschach/frontend/webkit/base.js'
import '@rorschach/frontend/webkit/r-list.js'
import '@rorschach/frontend/webkit/r-button.js'
import '@rorschach/frontend/webkit/r-empty-state.js'
import '@rorschach/frontend/webkit/r-section-header.js'

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
      return html`<r-empty-state name="file-text" text="No todos found."></r-empty-state>`
    }

    const items = this._todos.map((t, idx) => {
      const chips: any[] = []
      if (t.dueDate) {
        chips.push({ id: `due-${idx}`, label: `due: ${t.dueDate}`, status: 'blocked' })
      }
      if (t.recurrence) {
        chips.push({ id: `recur-${idx}`, label: `recurring: ${t.recurrence}`, status: 'running' })
      }
      return {
        id: String(idx),
        label: t.text,
        icon: t.done ? 'check' as const : 'circle' as const,
        chips: chips
      }
    })

    return html`
      <div class="nb-todos-container" style="padding: 1rem; flex: 1; display: flex; flex-direction: column; overflow: hidden;">
        <r-section-header title="Latest 10 Todos">
          <r-button 
            slot="actions"
            variant="ghost" 
            size="sm" 
            icon="activity" 
            @click=${this._fetchTodos} 
          >Refresh</r-button>
        </r-section-header>
        <r-list .items=${items} style="overflow-y: auto; flex: 1;"></r-list>
      </div>
    `
  }
}
