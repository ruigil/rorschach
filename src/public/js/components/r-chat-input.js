import { LightElement, ICONS, defineElement } from './base.js'
import { store } from '../store.js'

export class RChatInput extends LightElement {
  constructor() {
    super()
    this._mediaRecorder = null
    this._audioCtx = null
    this._recordingStream = null
    this._pendingImages = []
    this._pendingAudio = null
    this._pendingPdfs = []
    this._unsubConnected = null
    this._unsubWaiting = null
  }

  connectedCallback() {
    this._render()
    this._bindEvents()
    this._updateDisabled()
    this._unsubConnected = store.subscribe('isConnected', () => this._updateDisabled())
    this._unsubWaiting = store.subscribe('isWaiting', () => this._updateDisabled())
  }

  disconnectedCallback() {
    if (this._unsubConnected) {
      this._unsubConnected()
      this._unsubConnected = null
    }
    if (this._unsubWaiting) {
      this._unsubWaiting()
      this._unsubWaiting = null
    }
  }

  get input() {
    return this.querySelector('#input')
  }

  get mediaPreviews() {
    return this.querySelector('r-media-previews')
  }

  getPending() {
    return {
      images: [...this._pendingImages],
      audio: this._pendingAudio,
      pdfs: [...this._pendingPdfs],
    }
  }

  clearPending() {
    this._pendingImages = []
    this._pendingAudio = null
    this._pendingPdfs = []
    if (this.mediaPreviews) {
      this.mediaPreviews.clear()
    }
  }

  setDisabled(disabled) {
    const input = this.input
    const send = this.querySelector('#send')
    if (input) input.disabled = disabled
    if (send) send.disabled = disabled
  }

  focus() {
    if (this.input) this.input.focus()
  }

  _updateDisabled() {
    const disabled = !store.get('isConnected') || store.get('isWaiting')
    this.setDisabled(disabled)
  }

  _render() {
    this.innerHTML = `
      <div class="input-area">
        <r-media-previews id="image-previews" class="image-previews hidden"></r-media-previews>
        <form id="chat-form">
          <input type="file" id="file-input" accept="image/*,audio/*,.mp3,.wav,application/pdf,.pdf" multiple style="display:none">
          <button type="button" id="attach-btn" aria-label="Attach file">
            ${ICONS.attach}
          </button>
          <button type="button" id="mic-btn" aria-label="Record audio">
            ${ICONS.mic}
          </button>
          <textarea
            id="input"
            placeholder="Message…"
            autocomplete="off"
            rows="1"
            disabled
          ></textarea>
          <button type="submit" id="send" disabled aria-label="Send">
            ${ICONS.send}
          </button>
        </form>
        <p class="input-hint">Enter to send &nbsp;·&nbsp; Shift+Enter for new line</p>
      </div>
    `
  }

  _bindEvents() {
    const input = this.input
    const chatForm = this.querySelector('#chat-form')
    const attachBtn = this.querySelector('#attach-btn')
    const fileInput = this.querySelector('#file-input')
    const micBtn = this.querySelector('#mic-btn')

    input.addEventListener('input', () => {
      input.style.height = 'auto'
      input.style.height = Math.min(input.scrollHeight, 150) + 'px'
    })

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        chatForm.dispatchEvent(new Event('submit'))
      }
    })

    attachBtn.addEventListener('click', () => fileInput.click())

    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files ?? [])
      for (const file of files) {
        const dataUrl = await this._readFileAsDataUrl(file)
        if (file.type.startsWith('image/')) {
          this._pendingImages.push(dataUrl)
          if (this.mediaPreviews) this.mediaPreviews.addImage(dataUrl)
        } else if (file.type.startsWith('audio/') || /\.(mp3|wav)$/i.test(file.name)) {
          this._pendingAudio = dataUrl
          if (this.mediaPreviews) this.mediaPreviews.setAudio(dataUrl)
        } else if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
          this._pendingPdfs.push({ dataUrl, name: file.name })
          if (this.mediaPreviews) this.mediaPreviews.addPdf(dataUrl, file.name)
        }
      }
      fileInput.value = ''
    })

    micBtn.addEventListener('click', async () => {
      if (this._mediaRecorder && this._mediaRecorder.state === 'recording') {
        this._mediaRecorder.stop()
        return
      }

      try {
        this._recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true })
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
      const workletUrl = URL.createObjectURL(workletBlob)

      this._audioCtx = new AudioContext({ sampleRate: 16000 })
      await this._audioCtx.audioWorklet.addModule(workletUrl)
      URL.revokeObjectURL(workletUrl)

      const source = this._audioCtx.createMediaStreamSource(this._recordingStream)
      const workletNode = new AudioWorkletNode(this._audioCtx, 'recorder-processor')
      const samples = []

      workletNode.port.onmessage = (e) => { samples.push(e.data) }
      source.connect(workletNode)
      micBtn.classList.add('recording')

      this._mediaRecorder = {
        state: 'recording',
        stop: () => {
          this._mediaRecorder.state = 'stopped'
          workletNode.disconnect()
          source.disconnect()
          this._audioCtx.close()
          this._recordingStream.getTracks().forEach(t => t.stop())
          micBtn.classList.remove('recording')

          const totalLen = samples.reduce((n, s) => n + s.length, 0)
          const pcm = new Int16Array(totalLen)
          let offset = 0
          for (const chunk of samples) {
            for (let i = 0; i < chunk.length; i++) {
              pcm[offset++] = Math.max(-32768, Math.min(32767, chunk[i] * 32768))
            }
          }
          const wav = this._pcm16ToWav(pcm, 16000)
          const blob = new Blob([wav], { type: 'audio/wav' })
          const reader = new FileReader()
          reader.onload = () => {
            this._pendingAudio = reader.result
            if (this.mediaPreviews) this.mediaPreviews.setAudio(reader.result)
          }
          reader.readAsDataURL(blob)
        },
      }
    })

    chatForm.addEventListener('submit', (e) => {
      e.preventDefault()
      const text = input.value.trim()
      const attachments = [
        ...this._pendingImages.map(data => ({ kind: 'image', data })),
        ...(this._pendingAudio ? [{ kind: 'audio', data: this._pendingAudio }] : []),
        ...this._pendingPdfs.map(p => ({ kind: 'pdf', data: p.dataUrl, name: p.name })),
      ]

      if (!text && attachments.length === 0) return

      this.dispatchEvent(new CustomEvent('chat-submit', {
        bubbles: true,
        detail: { text, attachments },
      }))

      input.value = ''
      input.style.height = 'auto'
      this.clearPending()
    })
  }

  _readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  _pcm16ToWav(pcm, sampleRate) {
    const dataBytes = pcm.buffer
    const header = new ArrayBuffer(44)
    const view = new DataView(header)
    const channels = 1
    const byteRate = sampleRate * channels * 2
    const dataSize = dataBytes.byteLength

    const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)) }
    writeStr(0, 'RIFF')
    view.setUint32(4, 36 + dataSize, true)
    writeStr(8, 'WAVE')
    writeStr(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, channels, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, byteRate, true)
    view.setUint16(32, channels * 2, true)
    view.setUint16(34, 16, true)
    writeStr(36, 'data')
    view.setUint32(40, dataSize, true)

    const out = new Uint8Array(44 + dataSize)
    out.set(new Uint8Array(header), 0)
    out.set(new Uint8Array(dataBytes), 44)
    return out
  }
}

defineElement('r-chat-input', RChatInput)
