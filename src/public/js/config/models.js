export async function initModelSelects(cfg) {
  const chatSel     = document.getElementById('chat-model')
  const visionSel   = document.getElementById('vision-model')
  const audioSel    = document.getElementById('audio-model')
  const memorySel   = document.getElementById('memory-model')
  const notebookSel = document.getElementById('notebook-agent-model')
  const googleSel   = document.getElementById('google-apis-agent-model')

  for (const sel of [chatSel, visionSel, audioSel, memorySel, notebookSel, googleSel]) {
    sel.innerHTML = '<option value="" disabled>loading models…</option>'
  }

  let models = []
  try {
    const res = await fetch(new URL('models', location.href))
    if (res.ok) models = await res.json()
  } catch {}

  for (const [sel, savedVal, allowEmpty] of [
    [chatSel,     cfg.model,              false],
    [visionSel,   cfg.visionModel,        false],
    [audioSel,    cfg.audioModel,         true],
    [memorySel,   cfg.memoryModel,        true],
    [notebookSel, cfg.notebookAgentModel,     true],
    [googleSel,   cfg.googleApisAgentModel,   true],
  ]) {
    const emptyOpt = allowEmpty ? '<option value="">— none —</option>' : ''
    sel.innerHTML = emptyOpt + models.map(m => `<option value="${m}">${m}</option>`).join('')
    if (savedVal && models.includes(savedVal)) sel.value = savedVal
  }
}
