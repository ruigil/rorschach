import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { StoreController } from './store-controller.js';

type ShellConnectionState = {
  isConnected: boolean
};

@customElement('r-status-dot')
export class RStatusDot extends RorschachBase {
  @property({ type: String, reflect: true }) status = 'disconnected';
  @property({ type: String }) label = 'connecting…';

  private _isConnected = new StoreController<ShellConnectionState, 'isConnected'>(this, ['shell', 'isConnected']);

  static override styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
    }

    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--muted, #215060);
      transition: background 0.4s, box-shadow 0.4s;
      flex-shrink: 0;
    }

    :host([status="connected"]) .dot {
      background: var(--accent, #00c4d4);
      box-shadow: 0 0 8px rgba(0,196,212,0.5);
      animation: signalPulse 2.5s ease-out infinite;
    }

    :host([status="disconnected"]) .dot {
      background: var(--error, #e06030);
      box-shadow: 0 0 6px rgba(224,96,48,0.4);
    }

    :host([status="running"]) .dot {
      background: var(--green, #39e8a0);
      box-shadow: 0 0 4px var(--green-glow, rgba(57, 232, 160, 0.2));
    }

    :host([status="stopped"]) .dot {
      background: var(--muted, #215060);
    }

    :host([status="error"]) .dot {
      background: var(--error, #e06030);
    }

    .label {
      font-size: 0.68rem;
      font-weight: 500;
      color: var(--text-dim, #3d6878);
      letter-spacing: 0.06em;
      white-space: nowrap;
    }

    @keyframes signalPulse {
      0%   { box-shadow: 0 0 0 0 rgba(0,196,212,0.5); }
      70%  { box-shadow: 0 0 0 6px rgba(0,196,212,0); }
      100% { box-shadow: 0 0 0 0 rgba(0,196,212,0); }
    }
  `;

  override willUpdate() {
    const connected = this._isConnected.value;
    this.status = connected ? 'connected' : 'disconnected';
    this.label = connected ? 'connected' : 'reconnecting…';
  }

  override render() {
    return html`
      <span class="dot"></span>
      ${this.label ? html`<span class="label">${this.label}</span>` : ''}
    `;
  }
}
