import { customElement, html, RorschachBase } from '@rorschach/webkit';

@customElement('r-config-google-account')
export class RConfigGoogleAccount extends RorschachBase {
  override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    this._updateStatus();
  }

  private async _updateStatus() {
    const statusEl = this.querySelector('[data-google-status]') as HTMLElement | null;
    const connectBtn = this.querySelector('[data-google-connect]') as HTMLElement | null;
    const disconnectBtn = this.querySelector('[data-google-disconnect]') as HTMLElement | null;
    if (!statusEl) return;

    try {
      const res = await fetch(new URL('googleapis/auth/status', location.href));
      const data = res.ok ? await res.json() : { connected: false };
      if (data.connected) {
        statusEl.textContent = 'Connected';
        if (connectBtn) connectBtn.style.display = 'none';
        if (disconnectBtn) disconnectBtn.style.display = '';
      } else {
        statusEl.textContent = 'Not connected';
        if (connectBtn) connectBtn.style.display = '';
        if (disconnectBtn) disconnectBtn.style.display = 'none';
      }
    } catch {
      statusEl.textContent = 'Status unavailable';
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
    return html`
      <div class="field-row">
        <div>
          <div class="field-label">Google account</div>
          <div class="field-hint" data-google-status>checking…</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button type="button" class="btn-save" data-google-connect style="display:none" @click=${this._connect}>Connect</button>
          <button type="button" class="btn-reset" data-google-disconnect style="display:none" @click=${this._disconnect}>Disconnect</button>
        </div>
      </div>`;
  }
}
