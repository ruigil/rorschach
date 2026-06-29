import { html } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import { RorschachBase } from '@rorschach/frontend/webkit/base.js'

type HabitDef = {
  name: string
  unit: string
  dailyTarget?: number
}

type TrackerEntry = {
  date: string
  habit: string
  value: number
  description?: string
}

type HabitStats = {
  streak: number
  personalBest: number
  personalBestDay?: string
  weeklyTotal: number
  weeklyAvg: number
  monthlyTotal: number
  monthlyAvg: number
  count: number
}

@customElement('r-notebook-tracker')
export class RNotebookTracker extends RorschachBase {
  @state() private _habits: HabitDef[] = []
  @state() private _selectedHabit: string | null = null
  @state() private _year = new Date().getFullYear()
  @state() private _month = new Date().getMonth()
  @state() private _stats: HabitStats | null = null
  @state() private _entries: TrackerEntry[] = []
  @state() private _highlightedDays: string[] = []
  @state() private _valueMap: Record<string, string | number> = {}
  @state() private _selectedDate: string | null = null
  @state() private _selectedDayEntries: TrackerEntry[] = []
  @state() private _loadingHabits = true
  @state() private _loadingData = false
  @state() private _error: string | null = null

  override createRenderRoot() {
    return this // Light DOM
  }

  override connectedCallback() {
    super.connectedCallback()
    this._fetchHabits()
  }

  private async _fetchHabits() {
    try {
      this._loadingHabits = true
      const res = await fetch('/notebook/tracker/habits')
      if (!res.ok) throw new Error(await res.text())
      this._habits = await res.json()
      if (this._habits.length > 0) {
        // Default select the first habit
        this._selectedHabit = this._habits[0]!.name
        this._fetchHabitData()
      } else {
        this._loadingHabits = false
      }
      this._error = null
    } catch (e: any) {
      this._error = e.message || 'Failed to load habits list'
      this._loadingHabits = false
    }
  }

  private async _fetchHabitData() {
    if (!this._selectedHabit) return
    try {
      this._loadingData = true
      const habitName = encodeURIComponent(this._selectedHabit)
      
      // Fetch stats & entries in parallel
      const [statsRes, entriesRes] = await Promise.all([
        fetch(`/notebook/tracker/stats?habit=${habitName}`),
        fetch(`/notebook/tracker/entries?habit=${habitName}`)
      ])

      if (!statsRes.ok) throw new Error(await statsRes.text())
      if (!entriesRes.ok) throw new Error(await entriesRes.text())

      this._stats = await statsRes.json()
      this._entries = await entriesRes.json()
      
      // Compute calendar highlights and values
      const valMap: Record<string, string | number> = {}
      const highlights: string[] = []
      for (const entry of this._entries) {
        valMap[entry.date] = entry.value
        if (!highlights.includes(entry.date)) {
          highlights.push(entry.date)
        }
      }
      this._valueMap = valMap
      this._highlightedDays = highlights

      // Update active day selected entries if applicable
      if (this._selectedDate) {
        this._updateSelectedDayEntries(this._selectedDate)
      }
      
      this._error = null
    } catch (e: any) {
      this._error = e.message || 'Failed to load habit telemetry'
    } finally {
      this._loadingData = false
      this._loadingHabits = false
    }
  }

  private _onHabitChanged(e: Event) {
    const select = e.target as HTMLSelectElement
    this._selectedHabit = select.value
    this._selectedDate = null
    this._selectedDayEntries = []
    this._fetchHabitData()
  }

  private _handleMonthChange(e: CustomEvent) {
    this._year = e.detail.year
    this._month = e.detail.month
    // Keep habit selection, but clear daily entries
    this._selectedDate = null
    this._selectedDayEntries = []
  }

  private _handleDaySelected(e: CustomEvent) {
    const date = e.detail.date
    this._selectedDate = date
    this._updateSelectedDayEntries(date)
  }

  private _updateSelectedDayEntries(date: string) {
    this._selectedDayEntries = this._entries.filter(entry => entry.date === date)
  }

  override render() {
    if (this._loadingHabits) {
      return html`<div class="nb-loading-container">Loading habits list...</div>`
    }
    if (this._error && !this._selectedHabit) {
      return html`<div class="nb-error-container">${this._error}</div>`
    }
    if (this._habits.length === 0) {
      return html`
        <div class="nb-empty-container">
          <r-icon name="activity" style="opacity: 0.2; width: 40px; height: 40px; margin-bottom: 12px;"></r-icon>
          <div>No habits defined. Track habits using the coach agent first.</div>
        </div>
      `
    }

    const currentHabitDef = this._habits.find(h => h.name === this._selectedHabit)
    const unit = currentHabitDef?.unit ?? ''
    const target = currentHabitDef?.dailyTarget

    return html`
      <div class="nb-tracker-container">
        <!-- Selector Header -->
        <div class="nb-tracker-selector-bar">
          <label class="nb-select-label" for="habit-select">Tracked Metric:</label>
          <div class="nb-select-wrapper">
            <select id="habit-select" class="nb-habit-select" .value=${this._selectedHabit || ''} @change=${this._onHabitChanged}>
              ${this._habits.map(h => html`<option value="${h.name}">${h.name} (${h.unit})</option>`)}
            </select>
          </div>
        </div>

        <!-- Telemetry Stats Cards -->
        ${this._stats ? html`
          <div class="nb-tracker-stats-grid">
            <div class="nb-stat-card">
              <span class="nb-stat-label">Current Streak</span>
              <span class="nb-stat-value text-accent">🔥 ${this._stats.streak} day${this._stats.streak === 1 ? '' : 's'}</span>
            </div>
            <div class="nb-stat-card">
              <span class="nb-stat-label">Personal Best</span>
              <span class="nb-stat-value text-green">${this._stats.personalBest} ${unit}</span>
            </div>
            <div class="nb-stat-card">
              <span class="nb-stat-label">This Month</span>
              <span class="nb-stat-value">${this._stats.monthlyTotal} ${unit}</span>
              <span class="nb-stat-sub">avg: ${this._stats.monthlyAvg}/${unit}</span>
            </div>
          </div>
        ` : ''}

        <!-- Calendar and Logs Split View -->
        <div class="nb-tracker-layout">
          <!-- Calendar side -->
          <div class="nb-tracker-calendar-pane">
            <r-notebook-calendar
              .year=${this._year}
              .month=${this._month}
              .highlightedDays=${this._highlightedDays}
              .valueMap=${this._valueMap}
              .selectedDate=${this._selectedDate}
              @month-change=${this._handleMonthChange}
              @day-selected=${this._handleDaySelected}
            ></r-notebook-calendar>
            ${this._loadingData ? html`<div class="nb-inline-loader">Refreshing statistics…</div>` : ''}
          </div>

          <!-- Entries detail side -->
          <div class="nb-tracker-logs-pane">
            ${this._selectedDate ? html`
              <div class="nb-entry-header">
                <span class="nb-entry-title">Logs for ${this._selectedDate}</span>
              </div>
              <div class="nb-entry-body">
                ${this._selectedDayEntries.length > 0 ? html`
                  <div class="nb-logs-list">
                    ${this._selectedDayEntries.map(e => html`
                      <div class="nb-log-row">
                        <div class="nb-log-value-chip">
                          <span class="nb-log-num">${e.value}</span>
                          <span class="nb-log-unit">${unit}</span>
                        </div>
                        <div class="nb-log-info">
                          ${e.description ? html`<div class="nb-log-desc">${e.description}</div>` : html`<div class="nb-log-empty-desc">No details provided</div>`}
                          ${target !== undefined ? html`
                            <div class="nb-log-target-diff">
                              ${e.value >= target 
                                ? html`<span class="text-green">Target achieved (target: ${target})</span>` 
                                : html`<span class="text-dim">Progress: ${e.value}/${target}</span>`}
                            </div>
                          ` : ''}
                        </div>
                      </div>
                    `)}
                  </div>
                ` : html`
                  <div class="nb-no-logs">No logged data for this habit on this date.</div>
                `}
              </div>
            ` : html`
              <div class="nb-entry-empty">
                <r-icon name="activity" style="opacity: 0.2; width: 40px; height: 40px; margin-bottom: 12px;"></r-icon>
                <div>Select a day on the calendar to view its logged entries.</div>
              </div>
            `}
          </div>
        </div>
      </div>
    `
  }
}
