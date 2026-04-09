const attachBtn       = document.getElementById('attach-btn')
const fileInput       = document.getElementById('file-input')
const imagePreviewsEl = document.getElementById('image-previews')
const micBtn          = document.getElementById('mic-btn')

let pendingImages = []
let pendingAudio  = null
let pendingPdfs   = []

let mediaRecorder   = null
let audioCtx        = null
let recordingStream = null

// ─── Getters for other modules ───

export function getPendingImages() { return pendingImages }
export function getPendingAudio()  { return pendingAudio  }
export function getPendingPdfs()   { return pendingPdfs   }

export function clearPendingImages() { pendingImages = []; renderMediaPreviews() }
export function clearPendingAudio()  { pendingAudio = null; renderMediaPreviews() }
export function clearPendingPdfs()   { pendingPdfs  = []; renderMediaPreviews() }

// ─── File reading ───

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// ─── Previews ───

function renderMediaPreviews() {
  imagePreviewsEl.innerHTML = ''
  const hasContent = pendingImages.length > 0 || pendingAudio !== null || pendingPdfs.length > 0
  imagePreviewsEl.classList.toggle('hidden', !hasContent)
  if (!hasContent) return

  pendingImages.forEach((dataUrl, i) => {
    const wrap = document.createElement('div')
    wrap.className = 'image-thumb-wrap'
    const img = document.createElement('img')
    img.src = dataUrl
    img.className = 'image-thumb'
    const removeBtn = document.createElement('button')
    removeBtn.className = 'image-thumb-remove'
    removeBtn.textContent = '×'
    removeBtn.addEventListener('click', () => {
      pendingImages.splice(i, 1)
      renderMediaPreviews()
    })
    wrap.appendChild(img)
    wrap.appendChild(removeBtn)
    imagePreviewsEl.appendChild(wrap)
  })

  if (pendingAudio) {
    const wrap = document.createElement('div')
    wrap.className = 'audio-preview-wrap'
    const player = document.createElement('audio')
    player.src = pendingAudio
    player.controls = true
    player.className = 'audio-preview-player'
    const removeBtn = document.createElement('button')
    removeBtn.className = 'image-thumb-remove'
    removeBtn.textContent = '×'
    removeBtn.addEventListener('click', () => {
      pendingAudio = null
      renderMediaPreviews()
    })
    wrap.appendChild(player)
    wrap.appendChild(removeBtn)
    imagePreviewsEl.appendChild(wrap)
  }

  pendingPdfs.forEach((pdf, i) => {
    const wrap = document.createElement('div')
    wrap.className = 'pdf-preview-wrap'
    const icon = document.createElement('span')
    icon.className = 'pdf-preview-icon'
    icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
    const name = document.createElement('span')
    name.className = 'pdf-preview-name'
    name.textContent = pdf.name
    const removeBtn = document.createElement('button')
    removeBtn.className = 'image-thumb-remove pdf-remove'
    removeBtn.textContent = '×'
    removeBtn.addEventListener('click', () => {
      pendingPdfs.splice(i, 1)
      renderMediaPreviews()
    })
    wrap.appendChild(icon)
    wrap.appendChild(name)
    wrap.appendChild(removeBtn)
    imagePreviewsEl.appendChild(wrap)
  })
}

// ─── File attach ───

attachBtn.addEventListener('click', () => fileInput.click())

fileInput.addEventListener('change', async () => {
  const files = Array.from(fileInput.files ?? [])
  for (const file of files) {
    const dataUrl = await readFileAsDataUrl(file)
    if (file.type.startsWith('image/')) {
      pendingImages.push(dataUrl)
    } else if (file.type.startsWith('audio/') || /\.(mp3|wav)$/i.test(file.name)) {
      pendingAudio = dataUrl
    } else if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      pendingPdfs.push({ dataUrl, name: file.name })
    }
  }
  fileInput.value = ''
  renderMediaPreviews()
})

// ─── Mic recording ───

function pcm16ToWav(pcm, sampleRate) {
  const dataBytes = pcm.buffer
  const header    = new ArrayBuffer(44)
  const view      = new DataView(header)
  const channels  = 1
  const byteRate  = sampleRate * channels * 2
  const dataSize  = dataBytes.byteLength

  const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)) }
  writeStr(0, 'RIFF')
  view.setUint32(4,  36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16,         true)
  view.setUint16(20, 1,          true)
  view.setUint16(22, channels,   true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate,   true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16,         true)
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)

  const out = new Uint8Array(44 + dataSize)
  out.set(new Uint8Array(header), 0)
  out.set(new Uint8Array(dataBytes), 44)
  return out
}

micBtn.addEventListener('click', async () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop()
    return
  }

  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    return
  }

  const processorSrc = `
    class RecorderProcessor extends AudioWorkletProcessor {
      process(inputs) {
        const ch = inputs[0]?.[0]
        if (ch) this.port.postMessage(new Float32Array(ch))
        return true
      }
    }
    registerProcessor('recorder-processor', RecorderProcessor)
  `
  const workletBlob = new Blob([processorSrc], { type: 'application/javascript' })
  const workletUrl  = URL.createObjectURL(workletBlob)

  audioCtx = new AudioContext({ sampleRate: 16000 })
  await audioCtx.audioWorklet.addModule(workletUrl)
  URL.revokeObjectURL(workletUrl)

  const source      = audioCtx.createMediaStreamSource(recordingStream)
  const workletNode = new AudioWorkletNode(audioCtx, 'recorder-processor')
  const samples     = []

  workletNode.port.onmessage = (e) => { samples.push(e.data) }
  source.connect(workletNode)
  micBtn.classList.add('recording')

  mediaRecorder = {
    state: 'recording',
    stop: () => {
      mediaRecorder.state = 'stopped'
      workletNode.disconnect()
      source.disconnect()
      audioCtx.close()
      recordingStream.getTracks().forEach(t => t.stop())
      micBtn.classList.remove('recording')

      const totalLen = samples.reduce((n, s) => n + s.length, 0)
      const pcm = new Int16Array(totalLen)
      let offset = 0
      for (const chunk of samples) {
        for (let i = 0; i < chunk.length; i++) {
          pcm[offset++] = Math.max(-32768, Math.min(32767, chunk[i] * 32768))
        }
      }
      const wav  = pcm16ToWav(pcm, 16000)
      const blob = new Blob([wav], { type: 'audio/wav' })
      const reader = new FileReader()
      reader.onload  = () => { pendingAudio = reader.result; renderMediaPreviews() }
      reader.readAsDataURL(blob)
    },
  }
})
