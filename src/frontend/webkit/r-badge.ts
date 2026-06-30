import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase } from './base.js';

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
    :host([variant="actor"][status="running"]) { color: var(--green); background: rgba(69, 196, 154, 0.1); }
    :host([variant="actor"][status="stopped"]) { color: var(--text-dim); background: rgba(255,255,255,0.04); }
    :host([variant="actor"][status="error"])   { color: var(--error); background: rgba(201, 95, 82, 0.1); }

    /* Universal status mappings */
    :host([status]) {
      border: 1px solid var(--border);
      text-transform: uppercase;
      padding: 3px 8px !important;
      border-radius: 4px;
    }
    :host([status="running"]) {
      color: #b9fbff;
      border-color: rgba(0, 196, 212, 0.6);
      background: rgba(0, 196, 212, 0.05);
    }
    :host([status="completed"]) {
      color: #c9ffe4;
      border-color: rgba(57, 232, 160, 0.55);
      background: rgba(57, 232, 160, 0.05);
    }
    :host([status="blocked"]) {
      color: #fff1b3;
      border-color: rgba(220, 180, 40, 0.6);
      background: rgba(220, 180, 40, 0.05);
    }
    :host([status="failed"]), :host([status="error"]) {
      color: #ffc7bf;
      border-color: rgba(224, 80, 64, 0.6);
      background: rgba(224, 80, 64, 0.05);
    }
    :host([status="pending"]), :host([status="idle"]), :host([status="not-tracked"]), :host([status="not_tracked"]) {
      color: var(--text-dim);
      border-color: var(--border);
      background: rgba(255, 255, 255, 0.02);
    }
  `;

  override render() {
    return html`<slot></slot>`;
  }
}
