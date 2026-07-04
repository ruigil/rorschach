import {
  css,
  customElement,
  html,
  property,
  RorschachBase
} from './base.js';

@customElement('r-badge')
export class RBadge extends RorschachBase {
  @property({ type: String }) level = '';
  @property({ type: String }) variant = '';
  @property({ type: String }) status = '';

  static override styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      font-size: 0.62rem;
      font-weight: 500;
      letter-spacing: 0.08em;
      text-align: center;
      padding: 3px 8px !important;
      border-radius: 3px;
      font-family: var(--font-mono, monospace);
      white-space: nowrap;
    }
    :host([level="debug"]) { color: var(--log-debug); }
    :host([level="info"])  { color: var(--log-info); }
    :host([level="warn"])  { color: var(--log-warn); }
    :host([level="error"]) { color: var(--log-error); }

    :host([variant="actor"]) {
      font-size: 0.6rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      padding: 3px 8px !important;
    }
    :host([variant="actor"][status="running"]) { color: var(--green); background: var(--green-glow); }
    :host([variant="actor"][status="stopped"]) { color: var(--text-dim); background: var(--surface-2); }
    :host([variant="actor"][status="error"])   { color: var(--error); background: var(--error-bg); }

    /* Universal status mappings */
    :host([status]) {
      border: 1px solid var(--border);
      text-transform: uppercase;
      padding: 3px 8px !important;
      border-radius: 4px;
    }
    :host([status="running"]) {
      color: var(--accent);
      border-color: var(--accent-glow);
      background: var(--accent-dim);
    }
    :host([status="completed"]) {
      color: var(--green);
      border-color: var(--green-glow);
      background: var(--green-glow);
    }
    :host([status="blocked"]) {
      color: var(--warn);
      border-color: var(--border);
      background: var(--surface-2);
    }
    :host([status="failed"]), :host([status="error"]) {
      color: var(--error);
      border-color: var(--error-border);
      background: var(--error-bg);
    }
    :host([status="pending"]), :host([status="idle"]), :host([status="not-tracked"]), :host([status="not_tracked"]) {
      color: var(--text-dim);
      border-color: var(--border);
      background: var(--surface-2);
    }
  `;

  override render() {
    return html`<slot></slot>`;
  }
}
