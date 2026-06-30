import { html } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import { RorschachBase } from '@rorschach/frontend/webkit/base.js'
import '@rorschach/frontend/webkit/r-calendar.js'
import '@rorschach/frontend/webkit/r-card.js'
import '@rorschach/frontend/webkit/r-list.js'
import '@rorschach/frontend/webkit/r-empty-state.js'

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
      return html`<r-empty-state name="activity" text="No habits defined. Track habits using the coach agent first."></r-empty-state>`
    }

    const currentHabitDef = this._habits.find(h => h.name === this._selectedHabit)
    const unit = currentHabitDef?.unit ?? ''
    const target = currentHabitDef?.dailyTarget

    const logItems = this._selectedDayEntries.map((e, idx) => {
      const chips: any[] = []
      if (target !== undefined) {
        if (e.value >= target) {
          chips.push({ id: `achieved-${idx}`, label: `Target achieved (target: ${target})`, status: 'completed' })
        } else {
          chips.push({ id: `progress-${idx}`, label: `Progress: ${e.value}/${target}`, status: 'running' })
        }
      }
      return {
        id: String(idx),
        label: `${e.value} ${unit}`,
        description: e.description || 'No details provided',
        chips: chips
      }
    })

    return html`
      <div class="nb-tracker-container" style="height: 100%; display: flex; flex-direction: column; overflow: hidden;">
        <!-- Selector Header -->
        <div class="nb-tracker-selector-bar" style="display: flex; align-items: center; padding: 12px 16px; background: rgba(2, 6, 10, 0.4); border-bottom: 1px solid var(--border);">
          <label class="nb-select-label" for="habit-select" style="font-family: var(--font-ui); font-size: 0.72rem; font-weight: 600; text-transform: uppercase; color: var(--text-dim); margin-right: 12px; letter-spacing: 0.05em; white-space: nowrap;">Tracked Metric:</label>
          <div class="nb-select-wrapper" style="flex: 1;">
            <select id="habit-select" class="nb-habit-select" .value=${this._selectedHabit || ''} @change=${this._onHabitChanged} style="width: 100%; background: var(--surface-2, #0a1820); border: 1px solid var(--border, #0d1f2d); color: var(--text-mid, #8abccc); border-radius: 4px; padding: 6px 10px; font-family: var(--font-ui, sans-serif); font-size: 0.8rem; outline: none; cursor: pointer; transition: all 0.2s;">
              ${this._habits.map(h => html`<option value="${h.name}">${h.name} (${h.unit})</option>`)}
            </select>
          </div>
        </div>

        <!-- Telemetry Stats Cards -->
        ${this._stats ? html`
          <div class="nb-tracker-stats-grid" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 12px 16px 4px;">
            <r-card style="background: rgba(7, 21, 32, 0.55);">
              <span slot="header" style="font-size: 0.62rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Current Streak</span>
              <div style="font-size: 0.85rem; font-weight: 600; color: var(--accent-bright); text-align: center;">🔥 ${this._stats.streak} day${this._stats.streak === 1 ? '' : 's'}</div>
            </r-card>
            <r-card style="background: rgba(7, 21, 32, 0.55);">
              <span slot="header" style="font-size: 0.62rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Personal Best</span>
              <div style="font-size: 0.85rem; font-weight: 600; color: var(--green); text-align: center;">${this._stats.personalBest} ${unit}</div>
            </r-card>
            <r-card style="background: rgba(7, 21, 32, 0.55);">
              <span slot="header" style="font-size: 0.62rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">This Month</span>
              <div style="font-size: 0.85rem; font-weight: 600; color: var(--text); text-align: center;">${this._stats.monthlyTotal} ${unit}</div>
              <div style="font-size: 0.58rem; color: var(--text-dim); text-align: center; margin-top: 4px;">avg: ${this._stats.monthlyAvg}/${unit}</div>
            </r-card>
          </div>
        ` : ''}

        <!-- Calendar and Logs Split View -->
        <div class="nb-tracker-layout" style="display: flex; flex: 1; overflow: hidden;">
          <!-- Calendar side -->
          <div class="nb-tracker-calendar-pane" style="padding: 1rem; border-right: 1px solid var(--border); width: 312px; flex-shrink: 0; box-sizing: border-box;">
            <r-calendar
              .year=${this._year}
              .month=${this._month}
              .highlightedDays=${this._highlightedDays}
              .valueMap=${this._valueMap}
              .selectedDate=${this._selectedDate}
              @month-change=${this._handleMonthChange}
              @day-selected=${this._handleDaySelected}
            ></r-calendar>
            ${this._loadingData ? html`<div class="nb-inline-loader">Refreshing statistics…</div>` : ''}
          </div>

          <!-- Entries detail side -->
          <div class="nb-tracker-logs-pane" style="flex: 1; overflow-y: auto; padding: 1rem; background: rgba(2, 6, 10, 0.2); display: flex; flex-direction: column;">
            ${this._selectedDate ? html`
              <div class="nb-entry-header">
                <span class="nb-entry-title">Logs for ${this._selectedDate}</span>
              </div>
              <div class="nb-entry-body">
                ${logItems.length > 0 ? html`
                  <div style="padding: 4px 0;">
                    <r-list .items=${logItems}></r-list>
                  </div>
                ` : html`
                  <r-empty-state name="activity" text="No logged data for this habit on this date."></r-empty-state>
                `}
              </div>
            ` : html`<r-empty-state name="activity" text="Select a day on the calendar to view its logged entries."></r-empty-state>`}
          </div>
        </div>
      </div>
    `
  }
}
