const configForm = document.getElementById('config-form')
const saveStatus = document.getElementById('save-status')
const saveError  = document.getElementById('save-error')
const resetBtn   = document.getElementById('reset-btn')

const configDefaults = {
  logPath:                        'logs/app.jsonl',
  minLevel:                       'debug',
  flushIntervalMs:                3000,
  metricsIntervalMs:              5000,
  metricsEnabled:                 true,
  model:                          'openai/gpt-4o-mini',
  systemPrompt:                   '',
  historyWindowHours:                      4,
  reasoningEnabled:               false,
  reasoningEffort:                'medium',
  visionModel:                    'google/gemini-flash-1.5',
  audioModel:                     '',
  audioVoice:                     'alloy',
  bashCwd:                        '/workspace',
  webSearchCount:                 20,
  kgraphDbPath:                    './workspace/memory/kgraph',
  kgraphEmbeddingModel:            '',
  kgraphEmbeddingDimensions:       1536,
  memoryModel:                     '',
  memoryConsolidationIntervalMs:   30000,
  memoryReflectionIntervalMs:      604800000,
  notebookDir:                     './workspace/notebook',
  notebookAgentModel:              '',
  notebookConsolidationIntervalMs: 604800000,
  notebookMaxToolLoops:            10,
}

export async function fetchServerConfig() {
  try {
    const res = await fetch(new URL('config', location.href))
    if (res.ok) return { ...configDefaults, ...await res.json() }
  } catch {}
  return { ...configDefaults }
}

export function applyToForm(cfg) {
  configForm.logPath.value                       = cfg.logPath
  configForm.minLevel.value                      = cfg.minLevel
  configForm.flushIntervalMs.value               = cfg.flushIntervalMs
  configForm.metricsIntervalMs.value             = cfg.metricsIntervalMs
  configForm.metricsEnabled.checked              = cfg.metricsEnabled
  configForm.model.value                         = cfg.model
  configForm.systemPrompt.value                  = cfg.systemPrompt ?? ''
  configForm.historyWindowHours.value                 = cfg.historyWindowHours ?? 4
  configForm.reasoningEnabled.checked            = cfg.reasoningEnabled
  configForm.reasoningEffort.value               = cfg.reasoningEffort
  configForm.visionModel.value                   = cfg.visionModel
  configForm.audioModel.value                    = cfg.audioModel ?? ''
  configForm.audioVoice.value                    = cfg.audioVoice ?? 'alloy'
  configForm.bashCwd.value                       = cfg.bashCwd ?? '/workspace'
  configForm.webSearchCount.value                = cfg.webSearchCount ?? 20
  configForm.kgraphDbPath.value                    = cfg.kgraphDbPath ?? './workspace/memory/kgraph'
  configForm.kgraphEmbeddingModel.value            = cfg.kgraphEmbeddingModel ?? ''
  configForm.kgraphEmbeddingDimensions.value       = cfg.kgraphEmbeddingDimensions ?? 1536
  configForm.memoryModel.value                     = cfg.memoryModel ?? ''
  configForm.memoryConsolidationIntervalMs.value   = cfg.memoryConsolidationIntervalMs ?? 30000
  configForm.memoryReflectionIntervalMs.value      = cfg.memoryReflectionIntervalMs ?? 604800000
  configForm.notebookDir.value                     = cfg.notebookDir ?? './workspace/notebook'
  configForm.notebookAgentModel.value              = cfg.notebookAgentModel ?? ''
  configForm.notebookConsolidationIntervalMs.value = cfg.notebookConsolidationIntervalMs ?? 604800000
  configForm.notebookMaxToolLoops.value            = cfg.notebookMaxToolLoops ?? 10
}

function readFromForm() {
  return {
    logPath:                       configForm.logPath.value.trim(),
    minLevel:                      configForm.minLevel.value,
    flushIntervalMs:               Number(configForm.flushIntervalMs.value),
    metricsIntervalMs:             Number(configForm.metricsIntervalMs.value),
    metricsEnabled:                configForm.metricsEnabled.checked,
    model:                         configForm.model.value,
    systemPrompt:                  configForm.systemPrompt.value,
    historyWindowHours:                     Number(configForm.historyWindowHours.value),
    reasoningEnabled:              String(configForm.reasoningEnabled.checked),
    reasoningEffort:               configForm.reasoningEffort.value,
    visionModel:                   configForm.visionModel.value,
    audioModel:                    configForm.audioModel.value,
    audioVoice:                    configForm.audioVoice.value,
    bashCwd:                       configForm.bashCwd.value.trim(),
    webSearchCount:                Number(configForm.webSearchCount.value),
    kgraphDbPath:                    configForm.kgraphDbPath.value.trim(),
    kgraphEmbeddingModel:            configForm.kgraphEmbeddingModel.value.trim(),
    kgraphEmbeddingDimensions:       Number(configForm.kgraphEmbeddingDimensions.value),
    memoryModel:                     configForm.memoryModel.value,
    memoryConsolidationIntervalMs:   Number(configForm.memoryConsolidationIntervalMs.value),
    memoryReflectionIntervalMs:      Number(configForm.memoryReflectionIntervalMs.value),
    notebookDir:                     configForm.notebookDir.value.trim(),
    notebookAgentModel:              configForm.notebookAgentModel.value,
    notebookConsolidationIntervalMs: Number(configForm.notebookConsolidationIntervalMs.value),
    notebookMaxToolLoops:            Number(configForm.notebookMaxToolLoops.value),
  }
}

let saveTimer  = null
let errorTimer = null

function flashSaved() {
  saveError.classList.remove('visible')
  saveStatus.classList.add('visible')
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => saveStatus.classList.remove('visible'), 2200)
}

function flashError(msg) {
  saveStatus.classList.remove('visible')
  saveError.textContent = msg
  saveError.classList.add('visible')
  clearTimeout(errorTimer)
  errorTimer = setTimeout(() => saveError.classList.remove('visible'), 4000)
}

configForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const cfg = readFromForm()
  try {
    const res = await fetch(new URL('config', location.href), {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(cfg),
    })
    if (!res.ok) throw new Error(`server error ${res.status}`)
    flashSaved()
  } catch (err) {
    flashError(err.message)
  }
})

resetBtn.addEventListener('click', () => applyToForm(configDefaults))

// Config subtab switching
const configTabBtns = document.querySelectorAll('[data-config-tab]')
const configPanes   = document.querySelectorAll('[data-config-pane]')

configTabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    configTabBtns.forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    configPanes.forEach(p => p.classList.remove('active'))
    document.querySelector(`[data-config-pane="${btn.dataset.configTab}"]`).classList.add('active')
  })
})
