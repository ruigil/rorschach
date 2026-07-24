import {
  css,
  customElement,
  html,
  query,
  RorschachBase,
  sharedStyles,
  state,
  type PluginHostActions
} from '@rorschach/webkit';

@customElement('r-auth-profile')
export class RAuthProfile extends RorschachBase {
  @state() private fullName = '';
  @state() private avatar = '';
  @state() private phone = '';
  @state() private roles: string[] = [];
  @state() private saving = false;
  @state() private timezone = '';

  @query('#flash-msg') private _flashMsg!: any;

  static override styles = [
    sharedStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: var(--bg);
        color: var(--text);
        font-family: var(--font-ui, sans-serif);
      }
      .profile-container {
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
        max-width: 500px;
        margin: 2rem auto;
        padding: 2rem;
        background: var(--glass-bg);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
      }
      .avatar-wrapper {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.75rem;
      }
      .avatar-container {
        position: relative;
        width: 100px;
        height: 100px;
        border-radius: 50%;
        background: var(--surface-2);
        border: 2px dashed var(--border-mid);
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: border-color 0.2s, transform 0.2s;
      }
      .avatar-container:hover {
        border-color: var(--accent);
        transform: scale(1.02);
      }
      .avatar-container img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .avatar-container r-icon {
        width: 40px;
        height: 40px;
        color: var(--text-dim);
      }
      .avatar-overlay {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.6);
        opacity: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: opacity 0.2s;
      }
      .avatar-container:hover .avatar-overlay {
        opacity: 1;
      }
      .upload-text {
        color: #e8f6fa;
        font-size: 0.7rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        pointer-events: none;
      }
      .avatar-overlay input[type="file"] {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        opacity: 0;
        cursor: pointer;
      }
      .roles-container {
        display: flex;
        flex-direction: column;
        gap: 0.45rem;
      }
      .roles-label {
        font-size: 0.72rem;
        font-weight: 500;
        color: var(--text-mid);
        letter-spacing: 0.04em;
      }
      .roles-list {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
      }
      .role-badge {
        font-family: var(--font-mono, monospace);
        font-size: 0.65rem;
        padding: 3px 8px;
        border-radius: 4px;
        border: 1px solid var(--border);
        background: var(--surface-2);
        color: var(--text-mid);
        text-transform: uppercase;
      }
      .role-badge.admin {
        color: var(--error);
        border-color: var(--error-border);
        background: var(--error-bg);
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 1rem;
        margin-top: 1rem;
      }
    `
  ];

  override firstUpdated() {
    this._fetchProfile();
  }

  private async _fetchProfile() {
    try {
      const res = await fetch(new URL('auth/profile', location.href));
      if (res.ok) {
        const data = await res.json();
        this.fullName = data.fullName || '';
        this.avatar = data.avatar || '';
        this.phone = data.phone || '';
        this.roles = data.roles || [];
        this.timezone = data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      }
    } catch (err) {
      console.error('Failed to fetch profile', err);
    }
  }

  private _handleAvatarUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      const file = input.files[0];
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target && typeof event.target.result === 'string') {
          this.avatar = event.target.result;
        }
      };
      reader.readAsDataURL(file);
    }
  }

  private _handleNameChange(e: any) {
    this.fullName = e.detail?.value || '';
  }

  private _handleTimezoneChange(e: any) {
    this.timezone = e.detail?.value || '';
  }

  private get _timezoneOptions() {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const standardTzs = [
      { value: 'UTC', label: 'UTC' },
      { value: 'America/New_York', label: 'New York (EST/EDT)' },
      { value: 'America/Los_Angeles', label: 'Los Angeles (PST/PDT)' },
      { value: 'Europe/London', label: 'London (GMT/BST)' },
      { value: 'Europe/Paris', label: 'Paris (CET/CEST)' },
      { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
      { value: 'Australia/Sydney', label: 'Sydney (AEST/AEDT)' },
    ];
    if (detected && !standardTzs.some(tz => tz.value === detected)) {
      standardTzs.unshift({ value: detected, label: `Local (${detected})` });
    } else if (detected) {
      const idx = standardTzs.findIndex(tz => tz.value === detected);
      if (idx !== -1) {
        standardTzs[idx]!.label = `Local (${standardTzs[idx]!.label})`;
      }
    }
    return standardTzs;
  }

  private async _saveProfile() {
    if (this.saving) return;
    this.saving = true;
    try {
      const res = await fetch(new URL('auth/profile', location.href), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: this.fullName,
          avatar: this.avatar,
          timezone: this.timezone,
        }),
      });
      if (res.ok) {
        this._flashMsg?.save();
      } else {
        const data = await res.json().catch(() => ({}));
        this._flashMsg?.error(data.error || 'Failed to save profile');
      }
    } catch (err: any) {
      this._flashMsg?.error(err.message || 'Error saving profile');
    } finally {
      this.saving = false;
    }
  }

  override render() {
    return html`
      <r-panel elevation="1" class="flex-grow-1 flex-column">
        <r-toolbar slot="header-container">
          <r-tabs>
            <button active data-tab="profile">Profile</button>
          </r-tabs>
        </r-toolbar>
        <div class="flex-grow-1" style="overflow-y: auto;">
          <div class="profile-container">
            <div class="avatar-wrapper">
              <div class="avatar-container" title="Change Avatar">
                ${this.avatar
                  ? html`<img src="${this.avatar}" alt="Avatar" />`
                  : html`<r-icon name="user" size="xl"></r-icon>`}
                <div class="avatar-overlay">
                  <span class="upload-text">Upload</span>
                  <input type="file" accept="image/*" @change=${this._handleAvatarUpload} />
                </div>
              </div>
            </div>

            <r-input
              label="Full Name"
              placeholder="Enter your full name"
              .value=${this.fullName}
              @change=${this._handleNameChange}
            ></r-input>

            <r-select
              label="Timezone"
              variant="field"
              .value=${this.timezone}
              .options=${this._timezoneOptions}
              @change=${this._handleTimezoneChange}
            ></r-select>

            <r-input
              label="Phone"
              .value=${this.phone}
              disabled
            ></r-input>

            <div class="roles-container">
              <span class="roles-label">Roles</span>
              <div class="roles-list">
                ${this.roles.length > 0
                  ? this.roles.map(role => html`<span class="role-badge ${role === 'admin' ? 'admin' : ''}">${role}</span>`)
                  : html`<span style="font-size: 0.8rem; color: var(--text-dim);">No roles assigned</span>`}
              </div>
            </div>

            <div class="actions">
              <r-flash-message id="flash-msg"></r-flash-message>
              <r-button
                variant="primary"
                ?disabled=${this.saving}
                ?loading=${this.saving}
                @click=${this._saveProfile}
              >
                Save Changes
              </r-button>
            </div>
          </div>
        </div>
      </r-panel>
    `;
  }
}

export const reduceFrame = (_frame: any, _host: PluginHostActions) => {};
