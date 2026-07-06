import { customElement, html, RorschachBase, state } from '@rorschach/webkit';

@customElement('r-config-google-account')
export class RConfigGoogleAccount extends RorschachBase {
  @state() private _status: 'checking' | 'connected' | 'disconnected' | 'unavailable' = 'checking';

  override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    this._updateStatus();
  }

  private async _updateStatus() {
    try {
      const res = await fetch(new URL('googleapis/auth/status', location.href));
      const data = res.ok ? await res.json() : { connected: false };
      this._status = data.connected ? 'connected' : 'disconnected';
    } catch {
      this._status = 'unavailable';
    }
  }

  private _connect() {
    const popup = window.open(new URL('googleapis/auth/start', location.href), '_blank', 'width=520,height=640');
    if (!popup) return;
    const poll = setInterval(() => {
      if (popup.closed) {
        clearInterval(poll);
        this._updateStatus();
      }
    }, 500);
  }

  private async _disconnect() {
    await fetch(new URL('googleapis/auth/revoke', location.href), { method: 'POST' });
    this._updateStatus();
  }

  override render() {
    let statusText = 'checking…';
    let showConnect = false;
    let showDisconnect = false;

    if (this._status === 'connected') {
      statusText = 'Connected';
      showDisconnect = true;
    } else if (this._status === 'disconnected') {
      statusText = 'Not connected';
      showConnect = true;
    } else if (this._status === 'unavailable') {
      statusText = 'Status unavailable';
    }

    return html`
      <div class="field-row">
        <div>
          <div class="field-label">Google account</div>
          <div class="field-hint" data-google-status>${statusText}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          ${showConnect
            ? html`<button type="button" class="btn-save" data-google-connect @click=${this._connect}>Connect</button>`
            : ''}
          ${showDisconnect
            ? html`<button type="button" class="btn-reset" data-google-disconnect @click=${this._disconnect}>Disconnect</button>`
            : ''}
        </div>
      </div>`;
  }
}

