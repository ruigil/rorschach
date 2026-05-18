const toolsListEl = document.getElementById('tools-list')

export function onToolRegistered(msg) {
  toolsListEl?.register(msg.name, msg.schema)
}

export function onToolUnregistered(msg) {
  toolsListEl?.unregister(msg.name)
}
