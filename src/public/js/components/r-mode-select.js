import { LightElement, defineElement } from './base.js'
import { store } from '../store.js'
import { switchMode } from '../session.js'

function modeLabel(mode, displayName = '') {
  if (displayName) return displayName
  if (!mode) return 'Mode'
  return mode.charAt(0).toUpperCase() + mode.slice(1)
}

export class RModeSelect extends LightElement {
  constructor() {
    super()
    this._unsubs = []
    this._syncPending = false
    this._onChange = () => this._handleChange()
  }

  connectedCallback() {
    this._render()
    this.select?.addEventListener('change', this._onChange)
    this._unsubs = [
      store.subscribe('agents', () => this._sync()),
      store.subscribe('currentMode', () => this._sync()),
      store.subscribe('currentModeDisplayName', () => this._sync()),
      store.subscribe('isConnected', () => this._sync()),
      store.subscribe('isWaiting', () => this._sync()),
    ]
  }

  disconnectedCallback() {
    this.select?.removeEventListener('change', this._onChange)
    this._unsubs.forEach(unsub => unsub())
    this._unsubs = []
  }

  get select() {
    return this.$('#mode-select')
  }

  _render() {
    this.innerHTML = `
      <label class="mode-select-wrap" for="mode-select">
        <span>mode</span>
        <select id="mode-select" disabled>
          <option value="">loading</option>
        </select>
      </label>
    `
  }

  _sync() {
    if (this._syncPending) return
    this._syncPending = true
    requestAnimationFrame(() => {
      this._syncPending = false
      this._renderOptions()
    })
  }

  _renderOptions() {
    const select = this.select
    if (!select) return

    const selectedMode = store.get('currentMode')
    const agents = store.get('agents')
    select.innerHTML = ''

    const agentList = agents.length > 0
      ? agents
      : selectedMode ? [{ mode: selectedMode, displayName: store.get('currentModeDisplayName') || modeLabel(selectedMode), shortDesc: '' }] : []

    if (agentList.length === 0) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = 'loading'
      select.appendChild(opt)
      select.disabled = true
      return
    }

    for (const agent of agentList) {
      const opt = document.createElement('option')
      opt.value = agent.mode
      opt.textContent = agent.displayName || modeLabel(agent.mode)
      if (agent.shortDesc) opt.title = agent.shortDesc
      select.appendChild(opt)
    }

    if (selectedMode && !agentList.some(agent => agent.mode === selectedMode)) {
      const opt = document.createElement('option')
      opt.value = selectedMode
      opt.textContent = store.get('currentModeDisplayName') || modeLabel(selectedMode)
      select.appendChild(opt)
    }

    select.value = selectedMode || agentList[0].mode
    select.disabled = !store.get('isConnected') || store.get('isWaiting') || agentList.length < 2
  }

  _handleChange() {
    const select = this.select
    if (!select) return
    if (switchMode(select.value)) {
      select.disabled = true
    } else {
      this._sync()
    }
  }
}

defineElement('r-mode-select', RModeSelect)

