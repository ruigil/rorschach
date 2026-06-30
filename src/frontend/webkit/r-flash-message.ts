import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { RorschachBase } from './base.js';

@customElement('r-flash-message')
export class RFlashMessage extends RorschachBase {
  @state() private visible = false;
  @state() private type: 'save' | 'error' | '' = '';
  @state() private message = '';
  private _timer: any = null;

  static override styles = css`
    :host {
      display: contents;
    }

    .msg {
      font-size: 0.68rem;
      font-family: var(--font-mono, monospace);
      font-weight: 300;
      opacity: 0;
      transition: opacity 0.3s;
      margin-left: auto;
      white-space: nowrap;
    }

    .msg.visible { opacity: 1; }
    .msg.save    { color: var(--green); }
    .msg.error   { color: var(--error); }
  `;

  override render() {
    return html`
      <span class="msg ${this.type} ${this.visible ? 'visible' : ''}">
        ${this.message}
      </span>
    `;
  }

  show(type: 'save' | 'error', message: string, duration = 2200) {
    clearTimeout(this._timer);
    this.type = type;
    this.message = message;
    this.visible = true;
    
    this._timer = setTimeout(() => {
      this.visible = false;
    }, duration);
  }

  save(duration = 2200) {
    this.show('save', 'saved', duration);
  }

  error(message: string, duration = 4000) {
    this.show('error', message, duration);
  }
}
