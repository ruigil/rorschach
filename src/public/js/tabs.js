import { store } from './store.js'

const tabBtns = document.querySelectorAll('[data-tab]')
const logoSub = document.getElementById('logo-sub')

export function activateTab(tab) {
  const btn = document.querySelector(`[data-tab="${tab}"]`)
  const panel = document.getElementById('panel-' + tab)
  if (!btn || !panel) return
  tabBtns.forEach(b => b.classList.remove('active'))
  btn.classList.add('active')
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
  panel.classList.add('active')
  logoSub.textContent = tab
  if (tab === 'chat' && store.get('isConnected')) {
    document.querySelector('r-chat-input')?.focus()
  }
}

export function setTabVisible(tab, visible) {
  const btn = document.querySelector(`[data-tab="${tab}"]`)
  if (!btn) return
  btn.hidden = !visible
  if (!visible && btn.classList.contains('active')) activateTab('chat')
}

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    activateTab(btn.dataset.tab)
  })
})
