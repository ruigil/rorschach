import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { StoreController } from './store-controller.js';
import type { UsageEntry } from './types.js';

interface ShellUsageState {
  usage: UsageEntry[]
}

function formatTokens(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

@customElement('r-costs-table')
export class RCostsTable extends RorschachBase {
  private _usage = new StoreController<ShellUsageState, 'usage'>(this, ['shell', 'usage']);

  // Render to light DOM to reuse shell/observe styles
  override createRenderRoot() {
    return this;
  }

  private _getCostsMap() {
    const costsMap = new Map<string, UsageEntry>();
    this._usage.value.forEach(msg => {
      if (!msg.role || !msg.model) return;
      const key = `${msg.role}:${msg.model}`;
      const prev = costsMap.get(key) ?? { 
        role: msg.role, 
        model: msg.model, 
        inputTokens: 0, 
        outputTokens: 0, 
        contextWindow: null, 
        cost: 0 
      };
      
      costsMap.set(key, {
        ...prev,
        inputTokens: prev.inputTokens + (msg.inputTokens ?? 0),
        outputTokens: prev.outputTokens + (msg.outputTokens ?? 0),
        contextWindow: msg.contextWindow ?? prev.contextWindow,
        cost: (prev.cost ?? 0) + (msg.cost ?? 0),
      });
    });
    return costsMap;
  }

  override render() {
    const costsMap = this._getCostsMap();
    if (costsMap.size === 0) {
      return html`
        <r-empty-state variant="panel" text="no usage data yet"></r-empty-state>
      `;
    }

    let totalIn = 0, totalOut = 0, totalCost = 0;
    const entries = [...costsMap.values()];

    return html`
      <table class="costs-table">
        <thead>
          <tr>
            <th>role</th>
            <th>model</th>
            <th>in</th>
            <th>out</th>
            <th>ctx</th>
            <th>cost</th>
          </tr>
        </thead>
        <tbody>
          ${entries.map(entry => {
            totalIn += entry.inputTokens;
            totalOut += entry.outputTokens;
            totalCost += entry.cost ?? 0;
            const ctx = entry.contextWindow ? `${Math.round(entry.contextWindow / 1000)}k` : '—';
            const cost = entry.cost != null && entry.cost > 0 ? `$${entry.cost.toFixed(4)}` : '—';
            return html`
              <tr>
                <td>${entry.role}</td>
                <td title=${entry.model}>${entry.model}</td>
                <td>${formatTokens(entry.inputTokens)}</td>
                <td>${formatTokens(entry.outputTokens)}</td>
                <td>${ctx}</td>
                <td>${cost}</td>
              </tr>
            `;
          })}
        </tbody>
        <tfoot>
          <tr>
            <td>total</td>
            <td></td>
            <td>${formatTokens(totalIn)}</td>
            <td>${formatTokens(totalOut)}</td>
            <td></td>
            <td>${totalCost > 0 ? `$${totalCost.toFixed(4)}` : '—'}</td>
          </tr>
        </tfoot>
      </table>
    `;
  }
}
