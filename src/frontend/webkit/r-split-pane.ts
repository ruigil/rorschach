import { html, css } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { RorschachBase } from './base.js'

@customElement('r-split-pane')
export class RSplitPane extends RorschachBase {
  @property({ type: String, reflect: true }) orientation: 'horizontal' | 'vertical' = 'horizontal'
  @property({ type: Number, reflect: true }) splitPercent = 50
  @property({ type: Number }) minPercent = 10
  @property({ type: Number }) maxPercent = 90

  @state() private _dragging = false

  static override styles = css`
    :host {
      display: grid;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }

    :host([orientation="horizontal"]) {
      grid-template-rows: 1fr auto var(--split-size, 50%);
      grid-template-columns: 1fr;
    }

    :host([orientation="vertical"]) {
      grid-template-columns: 1fr auto var(--split-size, 50%);
      grid-template-rows: 1fr;
    }

    .resizer {
      background: var(--border);
      position: relative;
      z-index: 10;
      transition: background 0.15s;
    }

    .resizer:hover,
    .resizer.dragging {
      background: var(--accent);
    }

    :host([orientation="horizontal"]) .resizer {
      height: 9px;
      cursor: row-resize;
      margin: -4px 0;
      border-top: 3px solid transparent;
      border-bottom: 3px solid transparent;
      background-clip: padding-box;
    }

    :host([orientation="vertical"]) .resizer {
      width: 9px;
      cursor: col-resize;
      margin: 0 -4px;
      border-left: 3px solid transparent;
      border-right: 3px solid transparent;
      background-clip: padding-box;
    }

    .pane {
      overflow: hidden;
      position: relative;
      display: flex;
      flex-direction: column;
    }
  `

  private _handlePointerDown(e: PointerEvent) {
    if (e.button !== 0) return
    e.preventDefault()

    const resizer = e.currentTarget as HTMLElement
    resizer.setPointerCapture(e.pointerId)
    this._dragging = true

    const rect = this.getBoundingClientRect()

    const onPointerMove = (moveEv: PointerEvent) => {
      if (this.orientation === 'horizontal') {
        const next = ((rect.bottom - moveEv.clientY) / rect.height) * 100
        this.splitPercent = Math.max(this.minPercent, Math.min(this.maxPercent, next))
      } else {
        const next = ((rect.right - moveEv.clientX) / rect.width) * 100
        this.splitPercent = Math.max(this.minPercent, Math.min(this.maxPercent, next))
      }
      this.style.setProperty('--split-size', `${this.splitPercent}%`)

      this.dispatchEvent(new CustomEvent('resize', {
        detail: { splitPercent: this.splitPercent },
        bubbles: true,
        composed: true
      }))
    }

    const onPointerUp = () => {
      if (resizer.hasPointerCapture(e.pointerId)) {
        resizer.releasePointerCapture(e.pointerId)
      }
      this._dragging = false
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)

      this.dispatchEvent(new CustomEvent('resize-end', {
        detail: { splitPercent: this.splitPercent },
        bubbles: true,
        composed: true
      }))
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  override firstUpdated() {
    this.style.setProperty('--split-size', `${this.splitPercent}%`)
  }

  override render() {
    return html`
      <div class="pane primary">
        <slot name="primary"></slot>
      </div>
      <div
        class="resizer ${this._dragging ? 'dragging' : ''}"
        @pointerdown=${this._handlePointerDown}
      ></div>
      <div class="pane secondary">
        <slot name="secondary"></slot>
      </div>
    `
  }
}
