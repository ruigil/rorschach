import { LightElement, defineElement } from './base.js'

export class RConfigForm extends LightElement {
  constructor() {
    super()
    this._schemas = []
    this._currentValues = {}
    this._models = []
    this._saveTimer = null
    this._errorTimer = null
  }

  connectedCallback() {
    this._render()
    this._bindEvents()
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async loadSchemas() {
    await this._fetchConfigSchema()
    if (this._schemas.length === 0) return
    await Promise.all([this._fetchCurrentValues(), this._fetchModels()])
    this._renderForms()
  }

  async save() {
    const byPlugin = this._gatherValuesByPlugin()
    for (const [pluginId, patch] of Object.entries(byPlugin)) {
      try {
        const res = await fetch(new URL(`config/${pluginId}`, location.href), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
        if (!res.ok) throw new Error(`server error ${res.status}`)
      } catch (err) {
        this._flashError(`Failed to save ${pluginId}: ${err.message}`)
        return
      }
    }
    this._flashSaved()
  }

  reset() {
    this.loadSchemas()
  }

  // ─── Data fetching ────────────────────────────────────────────────────────

  async _fetchConfigSchema() {
    try {
      const res = await fetch(new URL('config/schema', location.href))
      if (res.ok) this._schemas = await res.json()
    } catch {}
  }

  async _fetchCurrentValues() {
    const pluginPaths = [...new Set(this._schemas.map(s => {
      const pluginId = s.id.split('.')[0]
      return `/config/${pluginId}`
    }))]

    for (const path of pluginPaths) {
      try {
        const res = await fetch(new URL(path.slice(1), location.href))
        if (res.ok) {
          const pluginId = path.split('/').pop()
          this._currentValues[pluginId] = await res.json()
        }
      } catch {}
    }
  }

  async _fetchModels() {
    try {
      const res = await fetch(new URL('models', location.href))
      if (res.ok) this._models = await res.json()
    } catch {}
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  _render() {
    this.innerHTML = `
      <div class="config-bar">
        <r-tabs class="config-subtabs" id="config-tabs"></r-tabs>
      </div>
      <div class="config-content">
        <form id="config-form" novalidate>
          <div id="config-form-container"></div>
          <div class="form-actions">
            <button type="submit" class="btn-save">Save</button>
            <button type="button" class="btn-reset" id="reset-btn">Reset</button>
            <r-flash-message id="flash-msg"></r-flash-message>
          </div>
        </form>
      </div>
    `
  }

  _bindEvents() {
    const form = this.$('#config-form')
    const resetBtn = this.$('#reset-btn')
    if (!form || !resetBtn) return

    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      await this.save()
    })

    resetBtn.addEventListener('click', () => {
      this.reset()
    })

    this.addEventListener('tab-change', (e) => {
      const tab = e.detail?.tab
      if (!tab) return
      this.$$('.config-pane').forEach(p => p.classList.remove('active'))
      const pane = this.$(`.config-pane[data-config-pane="${tab}"]`)
      if (pane) pane.classList.add('active')
    })
  }

  _renderForms() {
    const container = this.$('#config-form-container')
    const tabsContainer = this.$('#config-tabs')
    if (!container || !tabsContainer) return
    container.innerHTML = ''
    tabsContainer.innerHTML = ''

    const byTab = {}
    for (const s of this._schemas) {
      ;(byTab[s.tab] ??= []).push(s)
    }

    const tabNames = Object.keys(byTab)

    for (const [i, tab] of tabNames.entries()) {
      const btn = document.createElement('button')
      btn.className = `config-subtab${i === 0 ? ' active' : ''}`
      btn.dataset.configTab = tab
      btn.textContent = tab
      tabsContainer.appendChild(btn)
    }

    for (const [i, tab] of tabNames.entries()) {
      const pane = document.createElement('div')
      pane.className = `config-pane${i === 0 ? ' active' : ''}`
      pane.dataset.configPane = tab

      for (const section of byTab[tab]) {
        pane.appendChild(this._renderSection(section))
      }
      container.appendChild(pane)
    }

    this._initGoogleAccountWidgets()
  }

  _renderSection(section) {
    const el = document.createElement('div')
    el.className = 'config-section'
    const pluginId = section.id.split('.')[0]
    const pluginValues = this._currentValues[pluginId] ?? {}

    const configKey = section.configKey ?? ''
    let values = pluginValues
    if (configKey) {
      for (const part of configKey.split('.')) {
        values = values?.[part] ?? {}
      }
    }

    const header = document.createElement('div')
    header.className = 'pane-header'
    header.innerHTML = `<span class="pane-title">${section.title}</span>`
    if (section.subtitle) {
      header.innerHTML += `<span class="pane-sub">${section.subtitle}</span>`
    }
    el.appendChild(header)

    const props = section.schema.properties ?? {}
    for (const [key, fieldSchema] of Object.entries(props)) {
      el.appendChild(this._renderField(section.id, configKey, key, fieldSchema, values[key]))
    }
    return el
  }

  _renderField(sectionId, configKey, key, schema, value) {
    const widget = schema['x-ui']?.widget ?? this._inferWidget(schema)
    const secret = schema['x-ui']?.secret ?? false
    const label = schema['x-ui']?.label ?? key
    const resolvedValue = value ?? schema.default ?? ''

    const wrapper = document.createElement('div')
    wrapper.className = 'field'
    wrapper.dataset.sectionId = sectionId
    wrapper.dataset.configKey = configKey
    wrapper.dataset.fieldKey = key

    if (widget === 'toggle') {
      wrapper.innerHTML = `
        <div class="field-row">
          <div>
            <div class="field-label">${label}</div>
            ${schema.description ? `<div class="field-hint">${schema.description}</div>` : ''}
          </div>
          <label class="toggle">
            <input type="checkbox" name="${key}" ${resolvedValue ? 'checked' : ''} data-section="${sectionId}" data-config-key="${configKey}">
            <span class="toggle-track"></span>
          </label>
        </div>`
    } else if (widget === 'select') {
      const options = (schema.enum ?? []).map(v => `<option value="${v}" ${v === resolvedValue ? 'selected' : ''}>${v}</option>`).join('')
      wrapper.innerHTML = `
        <label class="field-label" for="${sectionId}-${key}">${label}</label>
        <select id="${sectionId}-${key}" name="${key}" data-section="${sectionId}" data-config-key="${configKey}">${options}</select>
        ${schema.description ? `<span class="field-hint">${schema.description}</span>` : ''}`
    } else if (widget === 'model-select') {
      const optHtml = this._models.map(m => `<option value="${m}" ${m === resolvedValue ? 'selected' : ''}>${m}</option>`).join('')
      wrapper.innerHTML = `
        <label class="field-label" for="${sectionId}-${key}">${label}</label>
        <select id="${sectionId}-${key}" name="${key}" data-section="${sectionId}" data-config-key="${configKey}" data-widget="model-select">
          <option value="">— none —</option>
          ${optHtml}
        </select>
        ${schema.description ? `<span class="field-hint">${schema.description}</span>` : ''}`
    } else if (widget === 'textarea') {
      const rows = schema['x-ui']?.rows ?? 3
      wrapper.innerHTML = `
        <label class="field-label" for="${sectionId}-${key}">${label}</label>
        <textarea id="${sectionId}-${key}" name="${key}" rows="${rows}" data-section="${sectionId}" data-config-key="${configKey}">${resolvedValue}</textarea>
        ${schema.description ? `<span class="field-hint">${schema.description}</span>` : ''}`
    } else if (widget === 'google-account') {
      wrapper.innerHTML = `
        <div class="field-row">
          <div>
            <div class="field-label">Google account</div>
            <div class="field-hint" data-google-status>checking…</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <button type="button" class="btn-save" data-google-connect style="display:none">Connect</button>
            <button type="button" class="btn-reset" data-google-disconnect style="display:none">Disconnect</button>
          </div>
        </div>`
      wrapper.dataset.widget = 'google-account'
    } else {
      const inputType = secret ? 'password' : widget === 'number' ? 'number' : 'text'
      const attrs = []
      if (schema.minimum != null) attrs.push(`min="${schema.minimum}"`)
      if (schema.maximum != null) attrs.push(`max="${schema.maximum}"`)
      if (schema.default != null) attrs.push(`placeholder="${schema.default}"`)
      wrapper.innerHTML = `
        <label class="field-label" for="${sectionId}-${key}">${label}</label>
        <input type="${inputType}" id="${sectionId}-${key}" name="${key}" value="${resolvedValue}" data-section="${sectionId}" data-config-key="${configKey}" ${attrs.join(' ')}>
        ${schema.description ? `<span class="field-hint">${schema.description}</span>` : ''}`
    }
    return wrapper
  }

  _inferWidget(schema) {
    if (schema.type === 'boolean') return 'toggle'
    if (schema.type === 'number') return 'number'
    if (schema.enum) return 'select'
    return 'text'
  }

  // ─── Google Account OAuth ─────────────────────────────────────────────────

  _initGoogleAccountWidgets() {
    this.$$('[data-widget="google-account"]').forEach(wrapper => {
      const statusEl = wrapper.querySelector('[data-google-status]')
      const connectBtn = wrapper.querySelector('[data-google-connect]')
      const disconnectBtn = wrapper.querySelector('[data-google-disconnect]')

      const updateStatus = async () => {
        try {
          const res = await fetch(new URL('googleapis/auth/status', location.href))
          const data = res.ok ? await res.json() : { connected: false }
          if (data.connected) {
            statusEl.textContent = 'Connected'
            connectBtn.style.display = 'none'
            disconnectBtn.style.display = ''
          } else {
            statusEl.textContent = 'Not connected'
            connectBtn.style.display = ''
            disconnectBtn.style.display = 'none'
          }
        } catch {
          statusEl.textContent = 'Status unavailable'
        }
      }

      connectBtn.addEventListener('click', () => {
        const popup = window.open(new URL('googleapis/auth/start', location.href), '_blank', 'width=520,height=640')
        const poll = setInterval(() => {
          if (popup?.closed) {
            clearInterval(poll)
            updateStatus()
          }
        }, 500)
      })

      disconnectBtn.addEventListener('click', async () => {
        await fetch(new URL('googleapis/auth/revoke', location.href), { method: 'POST' })
        updateStatus()
      })

      updateStatus()
    })
  }

  // ─── Form Submission ──────────────────────────────────────────────────────

  _gatherValuesByPlugin() {
    const byPlugin = {}
    this.$$('[data-config-key]').forEach(el => {
      if (el.dataset.widget === 'google-account') return
      const pluginId = el.dataset.section.split('.')[0]
      const configKey = el.dataset.configKey
      const key = el.name
      if (!key) return

      const value = el.type === 'checkbox' ? el.checked
        : el.type === 'number' ? Number(el.value)
        : el.value

      ;(byPlugin[pluginId] ??= {})

      if (configKey) {
        const parts = configKey.split('.')
        let target = byPlugin[pluginId]
        for (let i = 0; i < parts.length; i++) {
          target = target[parts[i]] ??= {}
        }
        target[key] = value
      } else {
        byPlugin[pluginId][key] = value
      }
    })
    return byPlugin
  }

  // ─── Flash Messages ───────────────────────────────────────────────────────

  _flashSaved() {
    const flash = this.$('#flash-msg')
    if (flash) flash.save()
  }

  _flashError(msg) {
    const flash = this.$('#flash-msg')
    if (flash) flash.error(msg)
  }
}

defineElement('r-config-form', RConfigForm)
