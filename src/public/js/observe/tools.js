const toolsListEl = document.getElementById('tools-list')

toolsListEl?.addEventListener('tool-registered', (e) => {
  toolsListEl.register(e.detail.name, e.detail.schema)
})

toolsListEl?.addEventListener('tool-unregistered', (e) => {
  toolsListEl.unregister(e.detail.name)
})
