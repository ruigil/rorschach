import './js/corona.js'
import './js/markdown.js'
import './js/tabs.js'
import './js/chat/media.js'
import './js/chat/plan-workspace.js'
import './js/chat/messages.js'
import './js/observe/costs.js'
import './js/observe/traces.js'
import './js/observe/tools.js'
import './js/observe/logs.js'
import './js/observe/actors.js'
import './js/observe/topics.js'
import './js/observe/graph.js'
import './js/observe/tabs.js'
import './js/config/form.js'
import { connect } from './js/connection.js'
import { state } from './js/state.js'
import { initConfigForms } from './js/config/form.js'
import { setTabVisible } from './js/tabs.js'

fetch(new URL('me', location.href))
  .then(r => r.json())
  .then(({ userId, roles }) => {
    state.currentUserId = userId
    state.currentUserRoles = roles ?? []
    const isAdmin = state.currentUserRoles.includes('admin')
    const isAnonymousMode = userId === 'anonymous'
    const canUseAdminSurface = isAnonymousMode || isAdmin
    setTabVisible('config', canUseAdminSurface)
    setTabVisible('observe', canUseAdminSurface)
    if (canUseAdminSurface) initConfigForms()
  })
  .catch(() => {
    setTabVisible('config', false)
    setTabVisible('observe', false)
  })

connect()
