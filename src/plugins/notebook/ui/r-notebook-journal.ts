import {
  css,
  customElement,
  html,
  RorschachBase,
  state,
  store,
  StoreController,
  send
} from '@rorschach/webkit';
import type { NotebookState } from './index.js'

@customElement('r-notebook-journal')
export class RNotebookJournal extends RorschachBase {
  private _splitPercent = new StoreController(this, ['notebook', 'splitPercent'])
  private _storeHighlightedDays = new StoreController(this, ['notebook', 'highlightedDays'])
  private _storeSelectedEntry = new StoreController(this, ['notebook', 'selectedEntry'])
  private _storeError = new StoreController(this, ['notebook', 'errorMessage'])

  @state() private _year = new Date().getFullYear()
  @state() private _month = new Date().getMonth()
  @state() private _selectedDate: string | null = null
  @state() private _loadingMonths = false
  @state() private _loadingEntry = false

  private get _highlightedDays() { return this._storeHighlightedDays.value ?? [] }
  private get _selectedEntry() { return this._storeSelectedEntry.value }
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
    this._fetchMonthData()
  }

  override updated() {
    if (this._storeHighlightedDays.value !== undefined && this._loadingMonths) {
      this._loadingMonths = false
    }
    if (this._storeSelectedEntry.value !== undefined && this._loadingEntry) {
      this._loadingEntry = false
    }
  }

  private _fetchMonthData() {
    this._loadingMonths = true
    const yearStr = String(this._year)
    const monthStr = String(this._month + 1).padStart(2, '0')
    send({ type: 'notebook.journal.months.request', year: yearStr, month: monthStr })
  }

  private _fetchEntry(date: string) {
    this._loadingEntry = true
    send({ type: 'notebook.journal.entry.request', date })
  }

  private _handleMonthChange(e: CustomEvent) {
    this._year = e.detail.year
    this._month = e.detail.month
    this._selectedDate = null
    store.namespace<NotebookState>('notebook').set('selectedEntry', null)
    this._fetchMonthData()
  }

  private _handleDaySelected(e: CustomEvent) {
    const date = e.detail.date
    this._selectedDate = date
    this._fetchEntry(date)
  }

  override render() {
    return html`
      <div class="nb-journal-container" style="height: 100%; display: flex; flex-direction: column;">
        <r-split-pane
          orientation="vertical"
          .splitPercent=${this._splitPercent.value ?? 70}
          .minPercent=${20}
          .maxPercent=${80}
          @resize-end=${(e: CustomEvent) => store.namespace<NotebookState>('notebook').set('splitPercent', e.detail.splitPercent)}
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
          <div slot="secondary" class="nb-journal-entry-pane" style="flex: 1; overflow-y: auto; padding: 1rem; background: var(--surface-2); display: flex; flex-direction: column; height: 100%;">
            ${this._selectedDate ? html`
              <div class="nb-entry-header">
              </div>
              <div class="nb-entry-body">
                ${this._loadingEntry ? html`
                  <div class="nb-loading-container">Fetching entry...</div>
                ` : html`
                  <div class="nb-entry-markdown">
                    ${this._selectedEntry ? html`<r-markdown .content=${this._selectedEntry}></r-markdown>` : 'No journal notes written for this date.'}
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
