import {
  css,
  customElement,
  html,
  RorschachBase,
  state,
  StoreController,
  send
} from '@rorschach/webkit';

@customElement('r-notebook-todos')
export class RNotebookTodos extends RorschachBase {
  private _storeTodos = new StoreController(this, ['notebook', 'todos'])
  private _storeError = new StoreController(this, ['notebook', 'errorMessage'])
  @state() private _loading = true

  private get _todos() { return this._storeTodos.value ?? [] }
  private get _error() { return this._storeError.value }

  static override styles = css`
    :host {
      display: block;
      height: 100%;
      width: 100%;
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
        id: t.id,
        label: t.text,
        icon: t.done ? 'check' as const : 'circle' as const,
        chips: chips
      }
    })

    return html`
      <div class="nb-todos-container" style="padding: 1rem; flex: 1; display: flex; flex-direction: column; overflow: hidden;">
        <r-section-header title="Latest 10 Todos"></r-section-header>
        <r-list 
          .items=${items} 
          selectable 
          @item-select=${this._onItemSelect} 
          style="overflow-y: auto; flex: 1;"
        ></r-list>
      </div>
    `
  }

  private _onItemSelect(e: CustomEvent) {
    const todo = this._todos.find(t => t.id === e.detail.id)
    if (todo && !todo.done) {
      send({ type: 'notebook.todos.complete', id: todo.id })
    }
  }
}
