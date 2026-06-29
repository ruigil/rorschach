import { html } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { RorschachBase } from '@rorschach/frontend/webkit/base.js'

@customElement('r-notebook-calendar')
export class RNotebookCalendar extends RorschachBase {
  @property({ type: Number }) year = new Date().getFullYear()
  @property({ type: Number }) month = new Date().getMonth() // 0-indexed
  @property({ type: Array }) highlightedDays: string[] = [] // YYYY-MM-DD dates
  @property({ type: Object }) valueMap: Record<string, string | number> = {} // YYYY-MM-DD -> value
  @property({ type: String }) selectedDate: string | null = null

  override createRenderRoot() {
    return this // Light DOM
  }

  private _prevMonth() {
    if (this.month === 0) {
      this.month = 11
      this.year -= 1
    } else {
      this.month -= 1
    }
    this._dispatchMonthChange()
  }

  private _nextMonth() {
    if (this.month === 11) {
      this.month = 0
      this.year += 1
    } else {
      this.month += 1
    }
    this._dispatchMonthChange()
  }

  private _dispatchMonthChange() {
    this.dispatchEvent(new CustomEvent('month-change', {
      detail: { year: this.year, month: this.month },
      bubbles: true,
      composed: true
    }))
  }

  private _selectDay(dateStr: string) {
    this.selectedDate = dateStr
    this.dispatchEvent(new CustomEvent('day-selected', {
      detail: { date: dateStr },
      bubbles: true,
      composed: true
    }))
  }

  override render() {
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ]

    const getDaysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate()
    const getFirstDayOfMonth = (y: number, m: number) => {
      const d = new Date(y, m, 1).getDay()
      return d === 0 ? 6 : d - 1 // Align Mon = 0, Sun = 6
    }

    const totalDays = getDaysInMonth(this.year, this.month)
    const startOffset = getFirstDayOfMonth(this.year, this.month)
    const cells: { dateStr: string; dayNum: number; isCurrentMonth: boolean }[] = []

    // Previous month padding
    const prevYear = this.month === 0 ? this.year - 1 : this.year
    const prevMonth = this.month === 0 ? 11 : this.month - 1
    const daysInPrevMonth = getDaysInMonth(prevYear, prevMonth)
    for (let i = startOffset - 1; i >= 0; i--) {
      const dayNum = daysInPrevMonth - i
      const dateStr = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`
      cells.push({ dateStr, dayNum, isCurrentMonth: false })
    }

    // Current month days
    for (let i = 1; i <= totalDays; i++) {
      const dateStr = `${this.year}-${String(this.month + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`
      cells.push({ dateStr, dayNum: i, isCurrentMonth: true })
    }

    // Next month padding to fill out 6 full rows (42 cells) to keep height consistent
    const nextYear = this.month === 11 ? this.year + 1 : this.year
    const nextMonth = this.month === 11 ? 0 : this.month + 1
    const remaining = 42 - cells.length
    for (let i = 1; i <= remaining; i++) {
      const dateStr = `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`
      cells.push({ dateStr, dayNum: i, isCurrentMonth: false })
    }

    const weekDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

    return html`
      <div class="nb-calendar">
        <div class="nb-calendar-header">
          <button class="nb-cal-btn" @click=${this._prevMonth}>
            <r-icon name="chevron-left"></r-icon>
          </button>
          <span class="nb-calendar-title">${monthNames[this.month]} ${this.year}</span>
          <button class="nb-cal-btn" @click=${this._nextMonth}>
            <r-icon name="chevron-right"></r-icon>
          </button>
        </div>

        <div class="nb-calendar-weekdays">
          ${weekDays.map(d => html`<div class="nb-weekday">${d}</div>`)}
        </div>

        <div class="nb-calendar-grid">
          ${cells.map(c => {
            const hasHighlight = this.highlightedDays.includes(c.dateStr)
            const hasVal = this.valueMap[c.dateStr] !== undefined
            const val = hasVal ? this.valueMap[c.dateStr] : null
            const isSelected = this.selectedDate === c.dateStr

            let classes = 'nb-calendar-day'
            if (!c.isCurrentMonth) classes += ' nb-day-padded'
            if (hasHighlight) classes += ' nb-day-highlighted'
            if (hasVal) classes += ' nb-day-tracked'
            if (isSelected) classes += ' active'

            return html`
              <div class="${classes}" @click=${() => this._selectDay(c.dateStr)}>
                <span class="nb-day-number">${c.dayNum}</span>
                ${val !== null ? html`<span class="nb-day-value">${val}</span>` : ''}
              </div>
            `
          })}
        </div>
      </div>
    `
  }
}
