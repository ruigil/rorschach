import { state } from './state.js'
import { focusChatInput } from './chat/messages.js'

const tabBtns = document.querySelectorAll('[data-tab]')
const logoSub = document.getElementById('logo-sub')

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
    document.getElementById('panel-' + btn.dataset.tab).classList.add('active')
    logoSub.textContent = btn.dataset.tab
    if (btn.dataset.tab === 'chat' && state.isConnected) focusChatInput()
  })
})
