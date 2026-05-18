import { LightElement } from './base.js'

export class RCostsTable extends LightElement {
  constructor() {
    super()
    this._costsMap = new Map()
  }

  addUsage(msg) {
    if (!msg.role || !msg.model) return
    const key  = `${msg.role}:${msg.model}`
    const prev = this._costsMap.get(key) ?? { role: msg.role, model: msg.model, inputTokens: 0, outputTokens: 0, contextWindow: null, cost: 0 }
    this._costsMap.set(key, {
      ...prev,
      inputTokens:   prev.inputTokens  + (msg.inputTokens  ?? 0),
      outputTokens:  prev.outputTokens + (msg.outputTokens ?? 0),
      contextWindow: msg.contextWindow ?? prev.contextWindow,
      cost:          (prev.cost ?? 0)  + (msg.cost ?? 0),
    })
  }

  render() {
    const empty = this.querySelector('r-empty-state')
    const table = this.querySelector('.costs-table')
    if (!table) return
    const tbody = table.querySelector('tbody')
    const tfoot = table.querySelector('tfoot')
    if (!tbody || !tfoot) return

    if (this._costsMap.size === 0) {
      if (empty) empty.style.display = 'flex'
      table.style.display = 'none'
      return
    }

    if (empty) empty.style.display = 'none'
    table.style.display = 'table'

    let totalIn = 0, totalOut = 0, totalCost = 0

    tbody.innerHTML = [...this._costsMap.values()].map(entry => {
      totalIn   += entry.inputTokens
      totalOut  += entry.outputTokens
      totalCost += entry.cost ?? 0
      const ctx  = entry.contextWindow ? `${Math.round(entry.contextWindow / 1000)}k` : '—'
      const cost = entry.cost != null && entry.cost > 0 ? `$${entry.cost.toFixed(4)}` : '—'
      return `<tr>
        <td>${entry.role}</td>
        <td title="${entry.model}">${entry.model}</td>
        <td>${formatTokens(entry.inputTokens)}</td>
        <td>${formatTokens(entry.outputTokens)}</td>
        <td>${ctx}</td>
        <td>${cost}</td>
      </tr>`
    }).join('')

    const totalCostStr = totalCost > 0 ? `$${totalCost.toFixed(4)}` : '—'
    tfoot.innerHTML = `<tr>
      <td>total</td>
      <td></td>
      <td>${formatTokens(totalIn)}</td>
      <td>${formatTokens(totalOut)}</td>
      <td></td>
      <td>${totalCostStr}</td>
    </tr>`
  }
}

function formatTokens(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

if (!customElements.get('r-costs-table')) {
  customElements.define('r-costs-table', RCostsTable)
}
