import './components/index.js'
import './corona.js'
import './markdown.js'
import { connect } from './connection.js'
import { store } from './store.js'
import { setTabVisible } from './tabs.js'
import { initSession } from './session.js'

fetch(new URL('me', location.href))
  .then(r => r.json())
  .then(({ userId, roles }) => {
    store.set('currentUserId', userId)
    store.set('currentUserRoles', (roles as string[]) ?? [])
    const roles_ = store.get('currentUserRoles') as string[]
    const isAdmin = roles_.includes('admin')
    const isAnonymousMode = userId === 'anonymous'
    const canUseAdminSurface = isAnonymousMode || isAdmin
    setTabVisible('config', canUseAdminSurface)
    setTabVisible('observe', canUseAdminSurface)
    if (canUseAdminSurface) (document.querySelector('r-config-form') as any)?.loadSchemas()
    if (userId && userId !== 'anonymous') {
      const logoutBtn = document.getElementById('logout-btn')
      if (logoutBtn) logoutBtn.style.display = ''
    }
  })
  .catch(() => {
    setTabVisible('config', false)
    setTabVisible('observe', false)
  })

store.subscribe('isWaiting', (waiting) => {
  document.querySelector('header')?.classList.toggle('streaming', !!waiting)
})

initSession()
connect()
