import { html, css } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { RorschachBase } from './base.js'

@customElement('r-calendar')
export class RCalendar extends RorschachBase {
  @property({ type: Number }) year = new Date().getFullYear()
  @property({ type: Number }) month = new Date().getMonth() // 0-indexed
  @property({ type: Array }) highlightedDays: string[] = [] // YYYY-MM-DD dates
  @property({ type: Object }) valueMap: Record<string, string | number> = {} // YYYY-MM-DD -> value
  @property({ type: String }) selectedDate: string | null = null

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 280px;
      max-width: 100%;
      margin: 0 auto;
      font-family: var(--font-ui, sans-serif);
    }

    .calendar-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 8px 12px;
      border-bottom: 1px solid var(--border, #0d1f2d);
      margin-bottom: 8px;
    }

    .calendar-title {
      font-size: 0.9rem;
      font-weight: 600;
      color: var(--text-mid, #8abccc);
    }

    .cal-btn {
      background: transparent;
      border: none;
      color: var(--text-dim, #3d6878);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }

    .cal-btn:hover {
      color: var(--text, #e8f6fa);
      background: rgba(255, 255, 255, 0.05);
    }

    .cal-btn svg {
      width: 14px;
      height: 14px;
    }

    .calendar-weekdays {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      text-align: center;
      font-size: 0.65rem;
      color: var(--text-dim, #3d6878);
      text-transform: uppercase;
      margin-bottom: 6px;
      font-weight: 500;
    }

    .calendar-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 3px;
    }

    .calendar-day {
      aspect-ratio: 1;
      background: rgba(10, 24, 32, 0.2);
      border: 1px solid rgba(13, 31, 45, 0.5);
      border-radius: 4px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.15s ease;
      position: relative;
    }

    .calendar-day:hover {
      border-color: var(--accent, #00c4d4);
      background: rgba(10, 24, 32, 0.5);
      box-shadow: 0 0 6px var(--accent-glow, rgba(0, 196, 212, 0.2));
    }

    .day-number {
      font-size: 0.75rem;
      color: var(--text, #e8f6fa);
    }

    .day-padded {
      opacity: 0.35;
    }

    .calendar-day.active {
      border-color: var(--accent-bright, #22e8f8);
      background: rgba(0, 196, 212, 0.12);
      box-shadow: 0 0 8px var(--accent-glow, rgba(0, 196, 212, 0.2));
      z-index: 2;
    }

    .day-highlighted::after {
      content: '';
      position: absolute;
      bottom: 3px;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--green, #39e8a0);
      box-shadow: 0 0 6px var(--green-glow, rgba(57, 232, 160, 0.2));
    }

    .day-tracked {
      background: rgba(0, 196, 212, 0.15);
      border-color: rgba(0, 196, 212, 0.35);
    }

    .day-value {
      font-family: var(--font-mono, monospace);
      font-size: 0.55rem;
      color: var(--accent-bright, #22e8f8);
      margin-top: 1px;
    }
  `

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

    // Next month padding to fill out 6 rows
    const nextYear = this.month === 11 ? this.year + 1 : this.year
    const nextMonth = this.month === 11 ? 0 : this.month + 1
    const remaining = 42 - cells.length
    for (let i = 1; i <= remaining; i++) {
      const dateStr = `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`
      cells.push({ dateStr, dayNum: i, isCurrentMonth: false })
    }

    const weekDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

    return html`
      <div class="calendar-header">
        <button class="cal-btn" @click=${this._prevMonth}>
          ${this.renderIcon('chevron-left')}
        </button>
        <span class="calendar-title">${monthNames[this.month]} ${this.year}</span>
        <button class="cal-btn" @click=${this._nextMonth}>
          ${this.renderIcon('chevron-right')}
        </button>
      </div>

      <div class="calendar-weekdays">
        ${weekDays.map(d => html`<div>${d}</div>`)}
      </div>

      <div class="calendar-grid">
        ${cells.map(c => {
          const hasHighlight = this.highlightedDays.includes(c.dateStr)
          const hasVal = this.valueMap[c.dateStr] !== undefined
          const val = hasVal ? this.valueMap[c.dateStr] : null
          const isSelected = this.selectedDate === c.dateStr

          let classes = 'calendar-day'
          if (!c.isCurrentMonth) classes += ' day-padded'
          if (hasHighlight) classes += ' day-highlighted'
          if (hasVal) classes += ' day-tracked'
          if (isSelected) classes += ' active'

          return html`
            <div class="${classes}" @click=${() => this._selectDay(c.dateStr)}>
              <span class="day-number">${c.dayNum}</span>
              ${val !== null ? html`<span class="day-value">${val}</span>` : ''}
            </div>
          `
        })}
      </div>
    `
  }
}
