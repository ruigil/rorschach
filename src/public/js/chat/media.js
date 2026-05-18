// Media state is now managed by r-chat-input component
// This file provides backward-compatible getters for any code that still needs them

let chatInput = null

export function initMedia() {
  chatInput = document.querySelector('r-chat-input')
}

export function getPendingImages() {
  return chatInput?.getPending().images ?? []
}

export function getPendingAudio() {
  return chatInput?.getPending().audio ?? null
}

export function getPendingPdfs() {
  return chatInput?.getPending().pdfs ?? []
}

export function clearPendingImages() {
  chatInput?.clearPending()
}

export function clearPendingAudio() {
  chatInput?.clearPending()
}

export function clearPendingPdfs() {
  chatInput?.clearPending()
}
