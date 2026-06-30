import { html } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import { RorschachBase } from '@rorschach/frontend/webkit/base.js'
import { renderMarkdown } from '@rorschach/frontend/webkit/markdown.js'
import { StoreController } from '@rorschach/frontend/webkit/store-controller.js'
import { store } from '@rorschach/frontend/webkit/store.js'
import type { NotebookState } from './index.js'
import '@rorschach/frontend/webkit/r-calendar.js'
import '@rorschach/frontend/webkit/r-empty-state.js'
import '@rorschach/frontend/webkit/r-split-pane.js'

@customElement('r-notebook-journal')
export class RNotebookJournal extends RorschachBase {
  private _splitPercent = new StoreController<NotebookState, 'splitPercent'>(this, ['notebook', 'splitPercent'])

  @state() private _year = new Date().getFullYear()
  @state() private _month = new Date().getMonth()
  @state() private _highlightedDays: string[] = []
  @state() private _selectedDate: string | null = null
  @state() private _selectedEntry: string | null = null
  @state() private _loadingMonths = false
  @state() private _loadingEntry = false
  @state() private _error: string | null = null

  override createRenderRoot() {
    return this // Light DOM
  }

  override connectedCallback() {
    super.connectedCallback()
    this._fetchMonthData()
  }

  private async _fetchMonthData() {
    try {
      this._loadingMonths = true
      const yearStr = String(this._year)
      const monthStr = String(this._month + 1).padStart(2, '0')
      const res = await fetch(`/notebook/journal/months?year=${yearStr}&month=${monthStr}`)
      if (!res.ok) throw new Error(await res.text())
      const days: string[] = await res.json()
      this._highlightedDays = days.map(d => `${yearStr}-${monthStr}-${String(d).padStart(2, '0')}`)
      this._error = null
    } catch (e: any) {
      this._error = e.message || 'Failed to sync calendar entries'
    } finally {
      this._loadingMonths = false
    }
  }

  private async _fetchEntry(date: string) {
    try {
      this._loadingEntry = true
      const res = await fetch(`/notebook/journal/entry?date=${encodeURIComponent(date)}`)
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      this._selectedEntry = data.content
    } catch (e: any) {
      this._selectedEntry = `Error loading entry: ${e.message}`
    } finally {
      this._loadingEntry = false
    }
  }

  private _handleMonthChange(e: CustomEvent) {
    this._year = e.detail.year
    this._month = e.detail.month
    this._selectedDate = null
    this._selectedEntry = null
    this._fetchMonthData()
  }

  private _handleDaySelected(e: CustomEvent) {
    const date = e.detail.date
    this._selectedDate = date
    this._fetchEntry(date)
  }

  override firstUpdated() {
    const currentVal = store.namespace<NotebookState>('notebook').get('splitPercent')
    if (!currentVal) {
      const rect = this.getBoundingClientRect()
      const w = rect.width || 1000
      const rightPercent = Math.round(((w - 312) / w) * 100)
      const clamped = Math.max(20, Math.min(80, rightPercent))
      store.namespace<NotebookState>('notebook').set('splitPercent', clamped)
    }
  }

  private _onResizeEnd(percent: number) {
    store.namespace<NotebookState>('notebook').set('splitPercent', percent)
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('rorschach.notebook.splitPercent', String(percent))
    }
  }

  override render() {
    return html`
      <div class="nb-journal-container" style="height: 100%; display: flex; flex-direction: column;">
        <r-split-pane
          orientation="vertical"
          .splitPercent=${this._splitPercent.value ?? 70}
          .minPercent=${20}
          .maxPercent=${80}
          @resize-end=${(e: CustomEvent) => this._onResizeEnd(e.detail.splitPercent)}
          style="flex: 1; min-height: 0;"
        >
          <!-- Calendar side -->
          <div slot="primary" class="nb-journal-calendar-pane" style="padding: 1rem; box-sizing: border-box; height: 100%; overflow-y: auto; border-right: 1px solid var(--border);">
            <r-calendar
              .year=${this._year}
              .month=${this._month}
              .highlightedDays=${this._highlightedDays}
              .selectedDate=${this._selectedDate}
              @month-change=${this._handleMonthChange}
              @day-selected=${this._handleDaySelected}
            ></r-calendar>
            ${this._loadingMonths ? html`<div class="nb-inline-loader">Scanning entries…</div>` : ''}
            ${this._error ? html`<div class="nb-inline-error">${this._error}</div>` : ''}
          </div>

          <!-- Entry detail side -->
          <div slot="secondary" class="nb-journal-entry-pane" style="flex: 1; overflow-y: auto; padding: 1rem; background: rgba(2, 6, 10, 0.2); display: flex; flex-direction: column; height: 100%;">
            ${this._selectedDate ? html`
              <div class="nb-entry-header">
                <span class="nb-entry-title">Entry for ${this._selectedDate}</span>
              </div>
              <div class="nb-entry-body">
                ${this._loadingEntry ? html`
                  <div class="nb-loading-container">Fetching entry...</div>
                ` : html`
                  <div class="nb-entry-markdown">
                    ${this._selectedEntry ? renderMarkdown(this._selectedEntry) : 'No journal notes written for this date.'}
                  </div>
                `}
              </div>
            ` : html`<r-empty-state name="file-text" text="Select a day on the calendar to read its journal entry."></r-empty-state>`}
          </div>
        </r-split-pane>
      </div>
    `
  }
}
