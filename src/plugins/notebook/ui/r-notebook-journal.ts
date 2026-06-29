import { html } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import { RorschachBase } from '@rorschach/frontend/webkit/base.js'
import { renderMarkdown } from '@rorschach/frontend/webkit/markdown.js'

@customElement('r-notebook-journal')
export class RNotebookJournal extends RorschachBase {
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
      this._error = e.message || 'Failed to load calendar data'
    } finally {
      this._loadingMonths = false
    }
  }

  private async _fetchEntry(date: string) {
    try {
      this._loadingEntry = true
      const res = await fetch(`/notebook/journal/entry?date=${date}`)
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

  override render() {
    return html`
      <div class="nb-journal-container">
        <div class="nb-journal-layout">
          <!-- Calendar side -->
          <div class="nb-journal-calendar-pane">
            <r-notebook-calendar
              .year=${this._year}
              .month=${this._month}
              .highlightedDays=${this._highlightedDays}
              .selectedDate=${this._selectedDate}
              @month-change=${this._handleMonthChange}
              @day-selected=${this._handleDaySelected}
            ></r-notebook-calendar>
            ${this._loadingMonths ? html`<div class="nb-inline-loader">Scanning entries…</div>` : ''}
            ${this._error ? html`<div class="nb-inline-error">${this._error}</div>` : ''}
          </div>

          <!-- Entry detail side -->
          <div class="nb-journal-entry-pane">
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
            ` : html`
              <div class="nb-entry-empty">
                <r-icon name="file-text" style="opacity: 0.2; width: 40px; height: 40px; margin-bottom: 12px;"></r-icon>
                <div>Select a day on the calendar to read its journal entry.</div>
              </div>
            `}
          </div>
        </div>
      </div>
    `
  }
}
