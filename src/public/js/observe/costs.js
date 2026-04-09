// key: `${role}:${model}` → { role, model, inputTokens, outputTokens, contextWindow, cost }
const costsMap = new Map()

function formatTokens(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function onUsageMsg(msg) {
  if (!msg.role || !msg.model) return
  const key  = `${msg.role}:${msg.model}`
  const prev = costsMap.get(key) ?? { role: msg.role, model: msg.model, inputTokens: 0, outputTokens: 0, contextWindow: null, cost: 0 }
  costsMap.set(key, {
    ...prev,
    inputTokens:   prev.inputTokens  + (msg.inputTokens  ?? 0),
    outputTokens:  prev.outputTokens + (msg.outputTokens ?? 0),
    contextWindow: msg.contextWindow ?? prev.contextWindow,
    cost:          (prev.cost ?? 0)  + (msg.cost ?? 0),
  })
  if (document.getElementById('obs-costs')?.classList.contains('active')) renderCostsTable()
}

export function renderCostsTable() {
  const empty = document.getElementById('costs-empty')
  const table = document.getElementById('costs-table')
  const tbody = document.getElementById('costs-rows')
  const tfoot = document.getElementById('costs-summary')
  if (!tbody || !tfoot) return

  if (costsMap.size === 0) {
    empty.style.display = 'flex'
    table.style.display = 'none'
    return
  }

  empty.style.display = 'none'
  table.style.display = 'table'

  let totalIn = 0, totalOut = 0, totalCost = 0

  tbody.innerHTML = [...costsMap.values()].map(entry => {
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
