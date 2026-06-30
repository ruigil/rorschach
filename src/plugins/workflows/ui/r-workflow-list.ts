import { html } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { RorschachBase } from '@rorschach/frontend/webkit/base.js'
import '@rorschach/frontend/webkit/r-list.js'
import '@rorschach/frontend/webkit/r-empty-state.js'

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
      return html`<r-empty-state name="git-branch" text="No saved workflows"></r-empty-state>`
    }

    const items = this.workflows.map(workflow => ({
      id: workflow.id,
      label: workflow.goal,
      meta: `${workflow.taskCount} task${workflow.taskCount === 1 ? '' : 's'}`,
      description: this._formatDateTime(workflow.createdAt),
      icon: 'git-branch' as const
    }))

    return html`
      <r-list
        .items=${items}
        selectable
        @item-select=${(e: CustomEvent) => this._open(e.detail.id)}
      ></r-list>
    `
  }

  private _open(workflowId: string) {
    this.dispatchEvent(new CustomEvent('open-workflow', { detail: { workflowId }, bubbles: true, composed: true }))
  }
}
