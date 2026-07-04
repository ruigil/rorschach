import {
  css,
  customElement,
  html,
  property,
  RorschachBase
} from '@rorschach/webkit';

// Fallback component for failed surface imports. The shell's plugin-host
// swaps a view's `contentTag` to `'r-surface-error'` when `import()` fails,
// so the view shows a visible error instead of rendering nothing.
@customElement('r-surface-error')
export class RSurfaceError extends RorschachBase {
  @property({ type: String }) surfaceId = ''

  static override styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      padding: 1rem;
      text-align: center;
    }
    .surface-error {
      color: var(--error, #e06030);
      font-family: var(--font-mono, monospace);
      font-size: 0.8rem;
      line-height: 1.5;
    }
  `

  override render() {
    return html`<div class="surface-error">
      Failed to load surface${this.surfaceId ? `: ${this.surfaceId}` : ''}.<br>
      Check the console for details.
    </div>`
  }
}
