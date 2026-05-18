// ─── Dynamic Config Form Renderer ───────────────────────────────────────────
//
// Fetches config schemas from the server, renders forms dynamically from
// JSON Schema definitions, and submits changes per plugin.

let schemas = []
let currentValues = {}
let models = []

// ─── Data Fetching ──────────────────────────────────────────────────────────

export async function fetchConfigSchema() {
  try {
    const res = await fetch(new URL('config/schema', location.href))
    if (res.ok) schemas = await res.json()
  } catch {}
  return schemas
}

async function fetchCurrentValues() {
  const pluginPaths = [...new Set(schemas.map(s => {
    const pluginId = s.id.split('.')[0]
    return `/config/${pluginId}`
  }))]

  for (const path of pluginPaths) {
    try {
      const res = await fetch(new URL(path.slice(1), location.href))
      if (res.ok) {
        const pluginId = path.split('/').pop()
        currentValues[pluginId] = await res.json()
      }
    } catch {}
  }
}

async function fetchModels() {
  try {
    const res = await fetch(new URL('models', location.href))
    if (res.ok) models = await res.json()
  } catch {}
}

// ─── Form Rendering ─────────────────────────────────────────────────────────

export async function initConfigForms() {
  const configForm = document.getElementById('config-form')
  const resetBtn   = document.getElementById('reset-btn')
  if (!configForm || !resetBtn) return

  configForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    await saveConfig()
  })

  resetBtn.addEventListener('click', () => {
    loadAndRender()
  })

  await loadAndRender()
}

async function loadAndRender() {
  await fetchConfigSchema()
  if (schemas.length === 0) return

  await Promise.all([fetchCurrentValues(), fetchModels()])
  renderForms()
}

function renderForms() {
  const container = document.getElementById('config-form-container')
  const tabsContainer = document.getElementById('config-tabs')
  container.innerHTML = ''
  tabsContainer.innerHTML = ''

  const byTab = {}
  for (const s of schemas) {
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
      pane.appendChild(renderSection(section))
    }
    container.appendChild(pane)
  }

  tabsContainer.querySelectorAll('[data-config-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.config-pane').forEach(p => p.classList.remove('active'))
      container.querySelector(`[data-config-pane="${btn.dataset.configTab}"]`).classList.add('active')
    })
  })

  initGoogleAccountWidgets()
}

function renderSection(section) {
  const el = document.createElement('div')
  el.className = 'config-section'
  const pluginId = section.id.split('.')[0]
  const pluginValues = currentValues[pluginId] ?? {}

  // Navigate to the config sub-object using configKey path
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
    el.appendChild(renderField(section.id, configKey, key, fieldSchema, values[key]))
  }
  return el
}

function renderField(sectionId, configKey, key, schema, value) {
  const widget = schema['x-ui']?.widget ?? inferWidget(schema)
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
    const optHtml = models.map(m => `<option value="${m}" ${m === resolvedValue ? 'selected' : ''}>${m}</option>`).join('')
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

function inferWidget(schema) {
  if (schema.type === 'boolean') return 'toggle'
  if (schema.type === 'number') return 'number'
  if (schema.enum) return 'select'
  return 'text'
}

// ─── Google Account OAuth ───────────────────────────────────────────────────

function initGoogleAccountWidgets() {
  document.querySelectorAll('[data-widget="google-account"]').forEach(wrapper => {
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

// ─── Form Submission ────────────────────────────────────────────────────────

function gatherValuesByPlugin() {
  const byPlugin = {}
  document.querySelectorAll('#config-form [data-config-key]').forEach(el => {
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

async function saveConfig() {
  const byPlugin = gatherValuesByPlugin()

  for (const [pluginId, patch] of Object.entries(byPlugin)) {
    try {
      const res = await fetch(new URL(`config/${pluginId}`, location.href), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) throw new Error(`server error ${res.status}`)
    } catch (err) {
      flashError(`Failed to save ${pluginId}: ${err.message}`)
      return
    }
  }
  flashSaved()
}

// ─── Flash Messages ─────────────────────────────────────────────────────────

let saveTimer  = null
let errorTimer = null

function flashSaved() {
  const flash = document.getElementById('flash-msg')
  if (flash) flash.save()
}

function flashError(msg) {
  const flash = document.getElementById('flash-msg')
  if (flash) flash.error(msg)
}

// ─── Event Listeners ────────────────────────────────────────────────────────
// Set up inside initConfigForms() after DOM is ready.
