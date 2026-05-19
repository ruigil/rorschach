import './js/components/index.js'
import './js/corona.js'
import './js/markdown.js'
import './js/tabs.js'
import { connect } from './js/connection.js'
import { store } from './js/store.js'
import { setTabVisible } from './js/tabs.js'
import { initSession } from './js/session.js'

fetch(new URL('me', location.href))
  .then(r => r.json())
  .then(({ userId, roles }) => {
    store.set('currentUserId', userId)
    store.set('currentUserRoles', roles ?? [])
    const isAdmin = store.get('currentUserRoles').includes('admin')
    const isAnonymousMode = userId === 'anonymous'
    const canUseAdminSurface = isAnonymousMode || isAdmin
    setTabVisible('config', canUseAdminSurface)
    setTabVisible('observe', canUseAdminSurface)
    if (canUseAdminSurface) document.querySelector('r-config-form')?.loadSchemas()
    if (userId && userId !== 'anonymous') {
      document.getElementById('logout-btn').style.display = ''
    }
  })
  .catch(() => {
    setTabVisible('config', false)
    setTabVisible('observe', false)
  })

store.subscribe('isWaiting', (waiting) => {
  document.querySelector('header')?.classList.toggle('streaming', waiting)
})

initSession()
connect()
