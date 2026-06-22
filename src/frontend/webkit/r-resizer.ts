import { html, css } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { RorschachBase } from './base.js'

// Generic drag-resizer primitive. Dispatches `r-resize` CustomEvents with
// `detail: { deltaX, deltaY }` as the user drags. Supports both vertical
// and horizontal resizing. Used by the workflow inspector splitter and
// the window dock resizer. Event-driven — the parent handles the actual
// state update (per plan §16.14).

@customElement('r-resizer')
export class RResizer extends RorschachBase {
  @property({ type: String }) orientation: 'horizontal' | 'vertical' = 'horizontal'
  @property({ type: String }) override ariaLabel = 'Resize'

  static override styles = css`
    :host { display: block; }
    .resizer {
      flex-shrink: 0;
      background: var(--border, #0d1f2d);
      transition: background 0.15s;
    }
    .resizer:hover, .resizer.active { background: var(--border-mid, #1a3548); }
    :host([orientation='horizontal']) .resizer {
      height: 9px; width: 100%; cursor: ns-resize;
    }
    :host([orientation='vertical']) .resizer {
      width: 9px; height: 100%; cursor: ew-resize;
    }
  `

  private _onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    const resizer = e.currentTarget as HTMLElement
    resizer.setPointerCapture(e.pointerId)
    resizer.classList.add('active')

    const startX = e.clientX
    const startY = e.clientY

    const onPointerMove = (moveEv: PointerEvent) => {
      const deltaX = moveEv.clientX - startX
      const deltaY = moveEv.clientY - startY
      this.dispatchEvent(new CustomEvent('r-resize', {
        detail: { deltaX, deltaY },
        bubbles: true,
        composed: true,
      }))
    }

    const onPointerUp = () => {
      resizer.classList.remove('active')
      if (resizer.hasPointerCapture(e.pointerId)) {
        resizer.releasePointerCapture(e.pointerId)
      }
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  override render() {
    return html`
      <div
        class="resizer"
        role="separator"
        aria-orientation=${this.orientation}
        aria-label=${this.ariaLabel}
        @pointerdown=${this._onPointerDown}
      ></div>
    `
  }
}
