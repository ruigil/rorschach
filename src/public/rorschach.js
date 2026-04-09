import './js/corona.js'
import './js/markdown.js'
import './js/tabs.js'
import './js/chat/media.js'
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
import './js/config/models.js'
import { connect } from './js/connection.js'
import { state } from './js/state.js'
import { fetchServerConfig, applyToForm } from './js/config/form.js'
import { initModelSelects } from './js/config/models.js'

fetchServerConfig().then(cfg => {
  initModelSelects(cfg).then(() => applyToForm(cfg))
})

fetch(new URL('me', location.href))
  .then(r => r.json())
  .then(({ userId }) => { state.currentUserId = userId })
  .catch(() => {})

connect()
