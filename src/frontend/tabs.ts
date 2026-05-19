import { store } from './store.js'

const tabBtns = document.querySelectorAll('[data-tab]')
const logoSub = document.getElementById('logo-sub')

export function activateTab(tab: string) {
  const btn = document.querySelector(`[data-tab="${tab}"]`) as HTMLElement | null
  const panel = document.getElementById('panel-' + tab)
  if (!btn || !panel) return
  tabBtns.forEach(b => (b as HTMLElement).classList.remove('active'))
  btn.classList.add('active')
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
  panel.classList.add('active')
  if (logoSub) logoSub.textContent = tab
  if (tab === 'chat' && store.get('isConnected')) {
    document.querySelector('r-chat-input')?.shadowRoot?.querySelector('textarea')?.focus()
  }
}

export function setTabVisible(tab: string, visible: boolean) {
  const btn = document.querySelector(`[data-tab="${tab}"]`) as HTMLElement | null
  if (!btn) return
  btn.hidden = !visible
  if (!visible && btn.classList.contains('active')) activateTab('chat')
}

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = (btn as HTMLElement).dataset.tab
    if (tab) activateTab(tab)
  })
})
