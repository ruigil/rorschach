export async function initModelSelects(cfg) {
  const chatSel   = document.getElementById('chat-model')
  const visionSel = document.getElementById('vision-model')
  const audioSel  = document.getElementById('audio-model')
  const memorySel = document.getElementById('memory-model')

  for (const sel of [chatSel, visionSel, audioSel, memorySel]) {
    sel.innerHTML = '<option value="" disabled>loading models…</option>'
  }

  let models = []
  try {
    const res = await fetch(new URL('models', location.href))
    if (res.ok) models = await res.json()
  } catch {}

  for (const [sel, savedVal, allowEmpty] of [
    [chatSel,   cfg.model,       false],
    [visionSel, cfg.visionModel, false],
    [audioSel,  cfg.audioModel,  true],
    [memorySel, cfg.memoryModel, true],
  ]) {
    const emptyOpt = allowEmpty ? '<option value="">— none —</option>' : ''
    sel.innerHTML = emptyOpt + models.map(m => `<option value="${m}">${m}</option>`).join('')
    if (savedVal && models.includes(savedVal)) sel.value = savedVal
  }
}
