import { html } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { RorschachBase } from '@rorschach/frontend/webkit/base.js'

// Workflow list view — renders saved workflows. Run chips live in the
// graph view toolbar next to the "Back to Workflows" button. Extracted
// from the r-workflow-workspace monolith. Renders to light DOM to reuse
// the global workspace.css styles.

@customElement('r-workflow-list')
export class RWorkflowList extends RorschachBase {
  @property({ type: Array }) workflows: any[] = []

  override createRenderRoot() { return this }

  private _formatDateTime(value: any): string {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
  }

  override render() {
    if (!this.workflows.length) {
      return html`<div class="plan-empty"><span>no saved workflows</span></div>`
    }
    return html`
      <div class="plan-list">
        ${this.workflows.map(workflow => html`
          <div class="plan-list-item">
            <button class="plan-list-main-btn" type="button" @click=${() => this._open(workflow.id)}>
              <span class="plan-list-goal">${workflow.goal}</span>
              <span class="plan-list-meta">${this._formatDateTime(workflow.createdAt)} · ${workflow.taskCount} task${workflow.taskCount === 1 ? '' : 's'}</span>
            </button>
          </div>
        `)}
      </div>
    `
  }

  private _open(workflowId: string) {
    this.dispatchEvent(new CustomEvent('open-workflow', { detail: { workflowId }, bubbles: true, composed: true }))
  }
}
