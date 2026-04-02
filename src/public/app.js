// ─── Void canvas — solar corona / eclipse WebGL shader ───

const voidCanvas = document.getElementById('void-canvas')
let voidRaf = null

const VERT_SRC = `
  attribute vec2 a_pos;
  void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`

const FRAG_SRC = `
  precision highp float;
  uniform vec2  u_res;
  uniform float u_time;

  float hash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1,0)), f.x),
      mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x),
      f.y
    );
  }

  float fbm3(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) { v += a * vnoise(p); p *= 2.07; a *= 0.5; }
    return v;
  }

  float fbm5(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.07; a *= 0.5; }
    return v;
  }

  void main() {
    vec2 uv = (gl_FragCoord.xy - u_res * 0.5) / min(u_res.x, u_res.y);
    float r  = length(uv);
    float ag = atan(uv.y, uv.x);
    float t  = u_time * 0.18;   // faster base speed

    const float MOON = 0.185;

    // Deep space — near-total dark during totality
    vec3 col = vec3(0.001, 0.002, 0.015);

    // Stars — more visible during eclipse
    for (int i = 0; i < 2; i++) {
      float scale = 40.0 + float(i) * 24.0;
      vec2  sg    = uv * scale + vec2(float(i) * 17.3, float(i) * 9.1);
      float s     = hash(floor(sg));
      if (s > 0.962) {
        vec2  sp = fract(sg) - 0.5;
        float sr = length(sp);
        float sb = smoothstep(0.2, 0.0, sr) * (s - 0.962) * 26.0;
        float tw = 0.75 + 0.25 * sin(u_time * (1.0 + float(i) * 0.6) + s * 31.4);
        col += vec3(0.88, 0.92, 1.0) * sb * tw;
      }
    }

    // Angle unit vector — avoids atan seam for noise sampling
    vec2 angVec = vec2(cos(ag), sin(ag));

    // Angular noise — each layer evolves at a distinct rate
    float aN1 = fbm3(angVec * 2.8 + t * 0.14);
    float aN2 = fbm3(angVec * 4.5 - t * 0.09 + 1.3);
    float aN3 = fbm3(angVec * 1.6 + vec2(t * 0.07, -t * 0.11) + 2.7);
    float aN4 = fbm3(angVec * 6.0 + t * 0.06 + 5.2);   // fine high-freq layer

    // Streamer rays — high powers create sharp bright rays against dark gaps
    float s1 = 0.5 + 0.5 * cos(ag *  3.0 + aN1 * 3.2);
    float s2 = 0.5 + 0.5 * cos(ag *  5.0 + aN2 * 2.8 + 1.3);
    float s3 = 0.5 + 0.5 * cos(ag *  7.0 + aN3 * 2.0 - 0.8);
    float s4 = 0.5 + 0.5 * cos(ag * 11.0 + aN4 * 1.5 + 2.1);
    float streamer = pow(s1,  6.0) * 0.44
                   + pow(s2,  8.0) * 0.30
                   + pow(s3, 10.0) * 0.16
                   + pow(s4, 12.0) * 0.10;

    // Radial corona falloffs
    float coronaR   = max(0.0, r - MOON);
    float innerFall = exp(-14.0 * coronaR) * smoothstep(MOON, MOON + 0.004, r);
    float outerFall = exp(-2.5  * coronaR) * smoothstep(MOON, MOON + 0.015, r);

    // Fine radial fibre texture
    float radTex = fbm3(uv * 5.5 + vec2(t * 0.14, t * 0.11));

    // Pulsing heartbeat on inner corona
    float pulse = 0.75 + 0.25 * sin(u_time * .8) * sin(u_time * 0.1);

    float innerCorona = innerFall * (0.60 + 0.40 * radTex) * pulse;

    // Each streamer glows up and down independently via angle-based phase offset
    float stPulse = 0.50 + 0.50 * sin(u_time * 0.75 + aN1 * 6.28)
                                * sin(u_time * 0.40 - aN2 * 4.00 + 1.3);
    // Near-black in gaps, bright on streamer peaks
    float outerCorona = outerFall * (0.04 + 0.96 * streamer * streamer) * stPulse;

    // Chromosphere — thin warm ring at the solar limb
    float chromo = smoothstep(MOON - 0.002, MOON + 0.001, r)
                 * smoothstep(MOON + 0.014, MOON + 0.004, r);

    // Prominences — two independent noise layers, larger and faster
    float promN1   = fbm5(angVec * 4.0 + t * 0.35);
    float promN2   = fbm3(angVec * 2.5 - t * 0.28 + 3.7);
    float promRing = smoothstep(MOON, MOON + 0.006, r) * smoothstep(MOON + 0.07, MOON + 0.015, r);
    float prom     = promRing * (pow(max(0.0, promN1 - 0.28) / 0.72, 2.0) * 3.5
                               + pow(max(0.0, promN2 - 0.35) / 0.65, 2.5) * 2.5);

    // Colors
    vec3 coronaWarm = vec3(1.00, 0.97, 0.88);   // warm white inner corona
    vec3 coronaCool = vec3(0.80, 0.90, 1.00);   // silver-blue outer streamers
    vec3 chromoCol  = vec3(1.00, 0.92, 0.60);   // warm amber chromosphere
    vec3 promColor  = vec3(0.98, 0.18, 0.12);   // H-alpha red prominence

    float outerBlend = smoothstep(MOON, MOON + 0.5, r);

    col += coronaWarm                              * innerCorona * 3.5;
    col += mix(coronaWarm, coronaCool, outerBlend) * outerCorona * 2.2;
    col += chromoCol * chromo * 1.6;
    col += promColor * prom;

    // Moon — absolute black occluder
    float moon = smoothstep(MOON + 0.003, MOON, r);
    col *= 1.0 - moon;

    // Filmic tone-map
    col = col / (col + 0.55);
    col = pow(col, vec3(0.9));

    gl_FragColor = vec4(col, 1.0);
  }
`

function initVoidGL() {
  const gl = voidCanvas.getContext('webgl')
  if (!gl) return null

  function compile(type, src) {
    const sh = gl.createShader(type)
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    return sh
  }

  const prog = gl.createProgram()
  gl.attachShader(prog, compile(gl.VERTEX_SHADER,   VERT_SRC))
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG_SRC))
  gl.linkProgram(prog)
  gl.useProgram(prog)

  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW)

  const aPos = gl.getAttribLocation(prog, 'a_pos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

  const uRes  = gl.getUniformLocation(prog, 'u_res')
  const uTime = gl.getUniformLocation(prog, 'u_time')

  return { gl, uRes, uTime }
}

function resizeVoidCanvas() {
  voidCanvas.width  = Math.ceil(window.innerWidth  * 0.5)
  voidCanvas.height = Math.ceil(window.innerHeight * 0.5)
}

resizeVoidCanvas()
const voidGL = initVoidGL()

if (voidGL) {
  const { gl, uRes, uTime } = voidGL
  const t0 = performance.now()
  let lastFrameTs = 0

  function drawVoidFrame(ts) {
    voidRaf = requestAnimationFrame(drawVoidFrame)
    if (ts - lastFrameTs < 33) return  // ~30 fps cap
    lastFrameTs = ts
    gl.viewport(0, 0, voidCanvas.width, voidCanvas.height)
    gl.uniform2f(uRes, voidCanvas.width, voidCanvas.height)
    gl.uniform1f(uTime, (performance.now() - t0) * 0.001)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(voidRaf); voidRaf = null }
    else if (!voidRaf)   { voidRaf = requestAnimationFrame(drawVoidFrame) }
  })
  window.addEventListener('resize', () => {
    resizeVoidCanvas()
    gl.viewport(0, 0, voidCanvas.width, voidCanvas.height)
  }, { passive: true })

  voidRaf = requestAnimationFrame(drawVoidFrame)
}

// ─── Markdown renderer ───

marked.use({ gfm: true, breaks: true })

function copyCode(btn) {
  const code = btn.closest('.code-block').querySelector('code').textContent
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = 'copied'
    setTimeout(() => { btn.textContent = 'copy' }, 1800)
  })
}

function renderMarkdown(text) {
  const el = document.createElement('div')
  el.className = 'md'
  el.innerHTML = marked.parse(text)
  el.querySelectorAll('pre > code').forEach(block => {
    const langClass = Array.from(block.classList).find(c => c.startsWith('language-'))
    const lang = langClass ? langClass.replace('language-', '') : 'code'
    hljs.highlightElement(block)
    const pre = block.parentElement
    const wrapper = document.createElement('div')
    wrapper.className = 'code-block'
    const header = document.createElement('div')
    header.className = 'code-header'
    header.innerHTML = `<span class="code-lang">${lang}</span><button class="copy-btn" onclick="copyCode(this)">copy</button>`
    pre.replaceWith(wrapper)
    wrapper.appendChild(header)
    wrapper.appendChild(pre)
  })
  return el
}

// ─── Tab switching ───

const tabBtns = document.querySelectorAll('[data-tab]')
const logoSub = document.getElementById('logo-sub')

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
    document.getElementById('panel-' + btn.dataset.tab).classList.add('active')
    logoSub.textContent = btn.dataset.tab
    if (btn.dataset.tab === 'chat' && isConnected) input.focus()
  })
})

// ─── Shared WebSocket ───

let isConnected = false
let isWaiting   = false
let ws          = null

const dot         = document.getElementById('dot')
const statusLabel = document.getElementById('status-label')

function setConnected(connected) {
  isConnected = connected
  dot.className = 'header-dot ' + (connected ? 'connected' : 'disconnected')
  statusLabel.textContent = connected ? 'connected' : 'reconnecting…'
  input.disabled  = !connected || isWaiting
  send.disabled   = !connected || isWaiting
}

function connect() {
  const wsUrl = new URL('ws', location.href)
  wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(wsUrl.href)

  ws.addEventListener('open', () => {
    setConnected(true)
    if (document.querySelector('[data-tab="chat"].active')) input.focus()
  })

  ws.addEventListener('close', () => {
    setConnected(false)
    removeThinking()
    streamWrap = null
    streamBubbleContainer = null
    streamBubble = null
    streamRawText = ''
    reasoningEl = null
    pendingSources = null
    sourcesWrap = null
    setWaiting(false)
    setTimeout(connect, 2000)
  })

  ws.addEventListener('error', () => ws.close())

  ws.addEventListener('message', (e) => {
    let msg
    try { msg = JSON.parse(e.data) } catch { return }

    if (msg.type === 'chunk' || msg.type === 'done' || msg.type === 'error' || msg.type === 'searching' || msg.type === 'sources' || msg.type === 'reasoningChunk') {
      handleChatMsg(msg)
    } else if (msg.type === 'usage') {
      updateUsageBar(msg)
    } else if (msg.type === 'generatedAudio') {
      onGeneratedAudio(msg)
    } else if (msg.type === 'log') {
      appendLog(msg)
    } else if (msg.type === 'metrics') {
      updateMetrics(msg)
    } else if (msg.type === 'trace') {
      onTraceSpan(msg)
    } else if (msg.type === 'tool_registered') {
      onToolRegistered(msg)
    } else if (msg.type === 'tool_unregistered') {
      onToolUnregistered(msg)
    }
  })
}

// ─── Chat ───

const messagesEl    = document.getElementById('messages')
const emptyEl       = document.getElementById('empty')
const chatForm      = document.getElementById('chat-form')
const input         = document.getElementById('input')
const send          = document.getElementById('send')
const attachBtn     = document.getElementById('attach-btn')
const imageInput    = document.getElementById('image-input')
const imagePreviewsEl = document.getElementById('image-previews')

let pendingImages    = []    // array of base64 data URLs
let pendingAudio     = null  // base64 data URL
let pendingAudioName = null  // display name

let thinkingEl          = null
let streamWrap          = null
let streamBubbleContainer = null
let streamBubble        = null
let streamRawText       = ''
let reasoningEl         = null
let pendingSources      = null
let sourcesWrap         = null

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

// ─── Image upload ───

attachBtn.addEventListener('click', () => imageInput.click())

imageInput.addEventListener('change', async () => {
  const files = Array.from(imageInput.files ?? [])
  for (const file of files) {
    const dataUrl = await readFileAsDataUrl(file)
    pendingImages.push(dataUrl)
  }
  imageInput.value = ''
  renderMediaPreviews()
})

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function renderMediaPreviews() {
  imagePreviewsEl.innerHTML = ''
  const hasContent = pendingImages.length > 0 || pendingAudio !== null
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
      pendingAudioName = null
      renderMediaPreviews()
    })
    wrap.appendChild(player)
    wrap.appendChild(removeBtn)
    imagePreviewsEl.appendChild(wrap)
  }
}

function clearPendingImages() {
  pendingImages = []
  renderMediaPreviews()
}

// ─── Audio upload ───

const audioInput     = document.getElementById('audio-input')
const audioAttachBtn = document.getElementById('audio-attach-btn')

audioAttachBtn.addEventListener('click', () => audioInput.click())

audioInput.addEventListener('change', async () => {
  const file = audioInput.files?.[0]
  if (!file) return
  pendingAudio = await readFileAsDataUrl(file)
  pendingAudioName = file.name
  audioInput.value = ''
  renderMediaPreviews()
})

function clearPendingAudio() {
  pendingAudio = null
  pendingAudioName = null
  renderMediaPreviews()
}

// ─── Mic recording ───

const micBtn = document.getElementById('mic-btn')

let mediaRecorder = null
let audioChunks   = []
let audioCtx      = null
let recordingStream = null

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

  // Use AudioWorkletNode to capture raw PCM → encode as WAV
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

      // Flatten samples → Int16 PCM → WAV → base64
      const totalLen = samples.reduce((n, s) => n + s.length, 0)
      const pcm = new Int16Array(totalLen)
      let offset = 0
      for (const chunk of samples) {
        for (let i = 0; i < chunk.length; i++) {
          pcm[offset++] = Math.max(-32768, Math.min(32767, chunk[i] * 32768))
        }
      }
      const wav = pcm16ToWav(pcm, 16000)
      const blob = new Blob([wav], { type: 'audio/wav' })
      readFileAsDataUrl(blob).then(dataUrl => {
        pendingAudio = dataUrl
        pendingAudioName = 'recording.wav'
        renderMediaPreviews()
      })
    },
  }
})

function pcm16ToWav(pcm, sampleRate) {
  const dataBytes = pcm.buffer
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const channels = 1
  const byteRate = sampleRate * channels * 2
  const dataSize = dataBytes.byteLength

  const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)) }
  writeStr(0, 'RIFF')
  view.setUint32(4,  36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1,         true)
  view.setUint16(22, channels,  true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate,  true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16,        true)
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)

  const out = new Uint8Array(44 + dataSize)
  out.set(new Uint8Array(header), 0)
  out.set(new Uint8Array(dataBytes), 44)
  return out
}

chatForm.addEventListener('submit', (e) => {
  e.preventDefault()
  const text = input.value.trim()
  if ((!text && pendingImages.length === 0 && !pendingAudio) || ws?.readyState !== WebSocket.OPEN || isWaiting) return
  appendUserMessage(text, pendingImages.slice(), pendingAudio)
  ws.send(JSON.stringify({ text, images: pendingImages.slice(), ...(pendingAudio ? { audio: pendingAudio } : {}) }))
  input.value = ''
  input.style.height = 'auto'
  clearPendingImages()
  clearPendingAudio()
  setWaiting(true)
  showThinking()
  const logoMark = document.querySelector('.logo-mark')
  logoMark.classList.add('noticing')
  setTimeout(() => logoMark.classList.remove('noticing'), 700)
})

function setWaiting(waiting) {
  isWaiting = waiting
  input.disabled  = waiting || !isConnected
  send.disabled   = waiting || !isConnected
  document.querySelector('header').classList.toggle('streaming', waiting)
  if (!waiting && document.querySelector('[data-tab="chat"].active')) input.focus()
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function appendUserMessage(text, images, audio) {
  if (emptyEl?.parentNode) emptyEl.remove()
  const wrap   = document.createElement('div')
  wrap.className = 'message user'
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  const label  = document.createElement('div')
  label.className = 'message-label'
  label.textContent = 'You'
  bubble.appendChild(label)
  if (images && images.length > 0) {
    const imgRow = document.createElement('div')
    imgRow.className = 'message-images'
    images.forEach(src => {
      const img = document.createElement('img')
      img.src = src
      img.className = 'message-image'
      imgRow.appendChild(img)
    })
    bubble.appendChild(imgRow)
  }
  if (audio) {
    const audioEl = document.createElement('audio')
    audioEl.src = audio
    audioEl.controls = true
    audioEl.className = 'message-audio'
    bubble.appendChild(audioEl)
  }
  if (text) {
    const textEl = document.createElement('span')
    textEl.textContent = text
    bubble.appendChild(textEl)
  }
  wrap.appendChild(bubble)
  messagesEl.appendChild(wrap)
  scrollToBottom()
  return wrap
}

function appendMessage(role, text) {
  if (emptyEl?.parentNode) emptyEl.remove()
  const wrap   = document.createElement('div')
  wrap.className = `message ${role}`
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  const label  = document.createElement('div')
  label.className = 'message-label'
  label.textContent = role === 'user' ? 'You' : role === 'assistant' ? 'Rorschach' : 'Error'
  bubble.appendChild(label)
  const textEl = document.createElement('div')
  textEl.className = 'bubble-body'
  textEl.textContent = text
  bubble.appendChild(textEl)
  wrap.appendChild(bubble)
  messagesEl.appendChild(wrap)
  scrollToBottom()
  return wrap
}

function showThinking(toolLabel = '', extraClass = '') {
  if (emptyEl?.parentNode) emptyEl.remove()
  const wrap   = document.createElement('div')
  wrap.className = 'message assistant thinking' + (extraClass ? ' ' + extraClass : '')
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  const labelEl = document.createElement('div')
  labelEl.className = 'message-label'
  labelEl.textContent = 'Rorschach'
  const dotsRow = document.createElement('div')
  dotsRow.className = 'dots-row'
  ;['dot', 'dot', 'dot'].forEach(() => {
    const d = document.createElement('div')
    d.className = 'dot'
    dotsRow.appendChild(d)
  })
  bubble.appendChild(labelEl)
  if (toolLabel) {
    const badge = document.createElement('div')
    badge.className = 'tool-badge'
    badge.textContent = toolLabel
    bubble.appendChild(badge)
  }
  bubble.appendChild(dotsRow)
  wrap.appendChild(bubble)
  messagesEl.appendChild(wrap)
  scrollToBottom()
  thinkingEl = wrap
}

function removeThinking() {
  thinkingEl?.remove()
  thinkingEl = null
}

function renderSources(sources) {
  const wrap = document.createElement('div')
  wrap.className = 'sources'
  const toggle = document.createElement('button')
  toggle.className = 'sources-toggle'
  toggle.textContent = `${sources.length} source${sources.length !== 1 ? 's' : ''}`
  const list = document.createElement('div')
  list.className = 'sources-list'
  sources.forEach((s) => {
    const item = document.createElement('a')
    item.className = 'source-item'
    item.href = s.url
    item.target = '_blank'
    item.rel = 'noopener noreferrer'
    const title = document.createElement('span')
    title.className = 'source-title'
    title.textContent = s.title
    const snippet = document.createElement('span')
    snippet.className = 'source-snippet'
    snippet.textContent = s.snippet
    item.appendChild(title)
    if (s.snippet) item.appendChild(snippet)
    list.appendChild(item)
  })
  toggle.addEventListener('click', () => {
    const open = list.classList.toggle('open')
    toggle.classList.toggle('open', open)
  })
  wrap.appendChild(toggle)
  wrap.appendChild(list)
  return wrap
}

function createMessageWrap() {
  const wrap   = document.createElement('div')
  wrap.className = 'message assistant'
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  const label  = document.createElement('div')
  label.className = 'message-label'
  label.textContent = 'Rorschach'
  bubble.appendChild(label)
  wrap.appendChild(bubble)
  return { wrap, bubble }
}

function createReasoningSection() {
  const details = document.createElement('details')
  details.className = 'reasoning'
  const summary = document.createElement('summary')
  summary.textContent = 'Thinking...'
  const content = document.createElement('pre')
  content.className = 'reasoning-content'
  details.appendChild(summary)
  details.appendChild(content)
  return { section: details, contentEl: content }
}

function toolActionLabel(toolName) {
  if (toolName === 'web_search') return 'searching the web…'
  if (toolName === 'analyze_image') return 'analysing image…'
  return `running ${toolName}…`
}

function handleChatMsg(msg) {
  if (msg.type === 'searching') {
    removeThinking()
    const tools = msg.tools ?? []
    const label = tools.length === 1
      ? toolActionLabel(tools[0])
      : tools.length > 1 ? `invoking ${tools.length} tools…` : 'working…'
    showThinking(label, 'searching')
  } else if (msg.type === 'sources') {
    pendingSources = msg.sources
  } else if (msg.type === 'reasoningChunk') {
    if (!streamWrap) {
      removeThinking()
      const { wrap, bubble } = createMessageWrap()
      streamWrap = wrap
      streamBubbleContainer = bubble
      messagesEl.appendChild(streamWrap)
    }
    if (!reasoningEl) {
      const { section, contentEl } = createReasoningSection()
      streamBubbleContainer.appendChild(section)
      reasoningEl = contentEl
    }
    reasoningEl.textContent += msg.text
    scrollToBottom()
  } else if (msg.type === 'chunk') {
    if (!streamBubble) {
      removeThinking()
      messagesEl.classList.add('receiving')
      setTimeout(() => messagesEl.classList.remove('receiving'), 700)
      if (!streamWrap) {
        const { wrap, bubble } = createMessageWrap()
        streamWrap = wrap
        streamBubbleContainer = bubble
        messagesEl.appendChild(streamWrap)
      }
      reasoningEl = null
      const bodyEl = document.createElement('div')
      bodyEl.className = 'bubble-body'
      if (pendingSources) {
        sourcesWrap = renderSources(pendingSources)
        streamBubbleContainer.appendChild(sourcesWrap)
        pendingSources = null
      }
      streamBubbleContainer.appendChild(bodyEl)
      streamBubble = bodyEl
      streamRawText = ''
    }
    streamRawText += msg.text
    streamBubble.textContent = streamRawText
    scrollToBottom()
  } else if (msg.type === 'done') {
    if (streamBubble && streamRawText) {
      streamBubble.textContent = ''
      streamBubble.appendChild(renderMarkdown(streamRawText))
    }
    streamRawText = ''
    streamBubble = null
    streamBubbleContainer = null
    streamWrap = null
    reasoningEl = null
    sourcesWrap = null
    setWaiting(false)
  } else if (msg.type === 'error') {
    removeThinking()
    streamWrap = null
    streamBubbleContainer = null
    streamBubble = null
    streamRawText = ''
    reasoningEl = null
    pendingSources = null
    sourcesWrap = null
    appendMessage('error', msg.text)
    setWaiting(false)
  }
}

function onGeneratedAudio(msg) {
  // Append an autoplay audio element into the current or last assistant bubble
  const target = streamBubbleContainer ?? messagesEl.querySelector('.message.assistant:last-child .bubble')
  if (!target) return
  const audioEl = document.createElement('audio')
  audioEl.src = msg.url
  audioEl.controls = true
  audioEl.autoplay = true
  audioEl.className = 'message-audio'
  target.appendChild(audioEl)
  scrollToBottom()
}

// ─── Usage bar ───

function formatTokens(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function updateUsageBar(msg) {
  document.getElementById('usage-bar').classList.remove('hidden')
  const ctx = msg.contextWindow ? ` · ${Math.round(msg.contextWindow / 1000)}k ctx` : ''
  document.getElementById('usage-model').textContent = msg.model + ctx
  document.getElementById('usage-in').textContent = formatTokens(msg.inputTokens)
  document.getElementById('usage-out').textContent = formatTokens(msg.outputTokens)
  document.getElementById('usage-ctx').textContent = msg.contextPercent != null
    ? `${(msg.contextPercent * 100).toFixed(1)}%`
    : '—'
  document.getElementById('usage-cost').textContent = msg.sessionCost != null
    ? `$${msg.sessionCost.toFixed(4)}`
    : '—'
}

// ─── Observe ───

const logStream      = document.getElementById('log-stream')
const logEmpty       = document.getElementById('log-empty')
const logCountEl     = document.getElementById('log-count')
const clearBtn       = document.getElementById('clear-logs')
const actorTreeEl    = document.getElementById('actor-tree')
const metricsEmpty   = document.getElementById('metrics-empty')
const metricsSummary = document.getElementById('metrics-summary')
const sumActors      = document.getElementById('sum-actors')
const sumRecv        = document.getElementById('sum-recv')
const sumDone        = document.getElementById('sum-done')
const sumFail        = document.getElementById('sum-fail')
const actorDetailEl  = document.getElementById('actor-detail')
const obsLogControls = document.getElementById('obs-log-controls')
const topicListEl    = document.getElementById('topic-list')
const topicsEmpty    = document.getElementById('topics-empty')

const obsTracesControls = document.getElementById('obs-traces-controls')
const tracesCountEl      = document.getElementById('traces-count')
const clearTracesBtn     = document.getElementById('clear-traces')
const toolsListEl        = document.getElementById('tools-list')
const toolsEmptyEl       = document.getElementById('tools-empty')
const tracesListEl       = document.getElementById('obs-traces-list')
const tracesEmptyEl      = document.getElementById('traces-empty')

// tracesMap: Map<traceId, TraceRecord>
// TraceRecord = { traceId, requestStart, requestEnd?, requestDuration?, spans: Map<spanId, SpanData> }
// SpanData = { spanId, parentSpanId?, actor, operation, startTime, endTime?, durationMs?, status, data? }
const tracesMap = new Map()
const MAX_TRACES = 20

function onTraceSpan(span) {
  let record = tracesMap.get(span.traceId)
  if (!record) {
    if (tracesMap.size >= MAX_TRACES) {
      tracesMap.delete(tracesMap.keys().next().value)
    }
    record = { traceId: span.traceId, requestStart: span.timestamp, spans: new Map() }
    tracesMap.set(span.traceId, record)
  }

  let spanData = record.spans.get(span.spanId)
  if (!spanData) {
    spanData = {
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      actor: span.actor,
      operation: span.operation,
      startTime: span.timestamp,
      status: span.status,
      data: span.data,
    }
    record.spans.set(span.spanId, spanData)
  } else {
    spanData.endTime = span.timestamp
    spanData.durationMs = span.durationMs
    spanData.status = span.status
    if (span.data) spanData.data = Object.assign({}, spanData.data, span.data)
  }

  if (span.operation === 'request' && (span.status === 'done' || span.status === 'error')) {
    record.requestDuration = span.durationMs
    record.requestEnd = span.timestamp
  }

  if (document.querySelector('.obs-subtab[data-subtab="traces"].active')) {
    renderTraces()
  }
  tracesCountEl.textContent = `${tracesMap.size} trace${tracesMap.size !== 1 ? 's' : ''}`
}

function computeDepths(spans) {
  const depthMap = new Map()
  const spanMap = new Map(spans.map(s => [s.spanId, s]))
  const getDepth = (span) => {
    if (depthMap.has(span.spanId)) return depthMap.get(span.spanId)
    if (!span.parentSpanId) { depthMap.set(span.spanId, 0); return 0 }
    const parent = spanMap.get(span.parentSpanId)
    const d = parent ? getDepth(parent) + 1 : 0
    depthMap.set(span.spanId, d)
    return d
  }
  spans.forEach(s => getDepth(s))
  return depthMap
}

function renderSpanRow(span, traceStart, totalMs, depth) {
  const offset = Math.max(0, ((span.startTime - traceStart) / totalMs) * 100)
  const duration = span.durationMs ?? (Date.now() - span.startTime)
  const width = Math.max(0.5, Math.min(100 - offset, (duration / totalMs) * 100))
  const isActive = span.status === 'started'
  const isError = span.status === 'error'
  const opClass = 'op-' + span.operation.replace(/[^a-z0-9]/g, '-')
  const dur = span.durationMs != null ? span.durationMs + 'ms' : '…'
  const actorShort = span.actor.split('/').pop() ?? span.actor
  const opLabel = (span.operation === 'tool-invoke' && span.data?.toolName)
    ? `tool-invoke · ${span.data.toolName}`
    : span.operation

  return `
    <div class="waterfall-row" style="padding-left:${8 + depth * 12}px">
      <div class="waterfall-label">
        <span class="wf-actor">${escHtml(actorShort)}</span>
        <span class="wf-op">${escHtml(opLabel)}</span>
      </div>
      <div class="waterfall-track">
        <div class="waterfall-bar ${opClass}${isActive ? ' wf-active' : ''}${isError ? ' wf-error' : ''}"
             style="left:${offset.toFixed(1)}%;width:${width.toFixed(1)}%"></div>
      </div>
      <div class="waterfall-dur">${escHtml(dur)}</div>
    </div>`
}

function renderTrace(record) {
  const spans = Array.from(record.spans.values())
  const now = Date.now()
  const totalMs = record.requestDuration ?? (now - record.requestStart)
  const isLive = !record.requestEnd
  const depthMap = computeDepths(spans)
  const sorted = [...spans].sort((a, b) => a.startTime - b.startTime)
  const rows = sorted.map(s => renderSpanRow(s, record.requestStart, totalMs, depthMap.get(s.spanId) ?? 0)).join('')
  const durStr = record.requestDuration != null ? record.requestDuration + 'ms' : '…'
  const traceIdShort = record.traceId.slice(-10)

  return `
    <div class="trace-item${isLive ? ' wf-live' : ''}">
      <div class="trace-header">
        <span class="trace-id">${escHtml(traceIdShort)}</span>
        <span class="trace-dur">${escHtml(durStr)}</span>
        ${isLive ? '<span class="trace-live-badge">live</span>' : ''}
      </div>
      <div class="trace-waterfall">${rows}</div>
    </div>`
}

function renderTraces() {
  if (tracesEmptyEl?.parentNode) tracesEmptyEl.remove()
  if (tracesMap.size === 0) {
    tracesListEl.innerHTML = ''
    if (!tracesListEl.querySelector('.empty-panel')) {
      const e = document.createElement('div')
      e.className = 'empty-panel'
      e.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg><span>awaiting traces</span>`
      tracesListEl.appendChild(e)
    }
    return
  }
  const arr = Array.from(tracesMap.values()).reverse()
  tracesListEl.innerHTML = arr.map(renderTrace).join('')
}

clearTracesBtn.addEventListener('click', () => {
  tracesMap.clear()
  tracesCountEl.textContent = '0 traces'
  renderTraces()
})

let logCount      = 0
const MAX_LOGS    = 500

let actorsMap     = {}
let selectedActor = null
const collapsedSet = new Set()

let topicsData    = []
const expandedTopics = new Set()

// ─── Tools ───

const toolsMap = {}

function onToolRegistered(msg) {
  toolsMap[msg.name] = msg.schema
  renderTools()
}

function onToolUnregistered(msg) {
  delete toolsMap[msg.name]
  renderTools()
}

function renderTools() {
  const names = Object.keys(toolsMap).sort()
  toolsListEl.querySelectorAll('.tool-row').forEach(el => el.remove())
  if (names.length === 0) {
    toolsEmptyEl.style.display = ''
    return
  }
  toolsEmptyEl.style.display = 'none'
  for (const name of names) {
    const desc = toolsMap[name]?.function?.description ?? ''
    const row = document.createElement('div')
    row.className = 'tool-row'
    row.innerHTML = `<span class="tool-name">${escHtml(name)}</span><span class="tool-desc">${escHtml(desc)}</span>`
    toolsListEl.appendChild(row)
  }
}

// Observe subtab switching
const obsMemoryControls = document.getElementById('obs-memory-controls')

document.querySelectorAll('.obs-subtab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.obs-subtab').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    document.querySelectorAll('.obs-subpanel').forEach(p => p.classList.remove('active'))
    document.getElementById('obs-' + btn.dataset.subtab).classList.add('active')
    const subtab = btn.dataset.subtab
    metricsSummary.style.display = subtab === 'metrics' && Object.keys(actorsMap).length > 0 ? 'flex' : 'none'
    obsLogControls.style.display = subtab === 'logs' ? 'flex' : 'none'
    obsTracesControls.style.display = subtab === 'traces' ? 'flex' : 'none'
    obsMemoryControls.style.display = subtab === 'memory' ? 'flex' : 'none'
    if (subtab === 'traces') renderTraces()
    if (subtab === 'memory') fetchKgraph()
  })
})

document.getElementById('memory-refresh').addEventListener('click', fetchKgraph)

// ─── Knowledge graph ───

const LABEL_COLORS = {
  Person:     { fill: 'rgba(0,196,212,0.12)',  stroke: '#00c4d4' },
  User:       { fill: 'rgba(57,232,160,0.12)', stroke: '#39e8a0' },
  Project:    { fill: 'rgba(196,132,58,0.12)', stroke: '#c4843a' },
  Event:      { fill: 'rgba(91,160,184,0.12)', stroke: '#5ba0b8' },
  Preference: { fill: 'rgba(224,96,48,0.12)',  stroke: '#e06030' },
}
const DEFAULT_NODE_COLOR = { fill: 'rgba(10,24,32,0.5)', stroke: '#1a3548' }

function nodeColor(label)       { return (LABEL_COLORS[label] || DEFAULT_NODE_COLOR).fill }
function nodeColorStroke(label) { return (LABEL_COLORS[label] || DEFAULT_NODE_COLOR).stroke }

async function fetchKgraph() {
  const statsEl = document.getElementById('memory-stats')
  statsEl.textContent = 'loading…'
  try {
    const res = await fetch(new URL('kgraph', location.href))
    const graph = await res.json()
    renderKgraph(graph)
    statsEl.textContent = `${graph.nodes.length} nodes · ${graph.edges.length} edges`
  } catch (e) {
    statsEl.textContent = 'error'
  }
}

function renderKgraph(graph) {
  const container = document.getElementById('memory-graph')
  container.innerHTML = ''

  const { nodes, edges } = graph

  if (nodes.length === 0) {
    container.innerHTML = `<div class="empty-panel"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><circle cx="5" cy="12" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><line x1="7" y1="11.5" x2="17" y2="6.5"/><line x1="7" y1="12.5" x2="17" y2="17.5"/></svg><span>no graph data</span></div>`
    return
  }

  const width  = container.clientWidth
  const height = container.clientHeight
  const R = 22  // node radius

  const simNodes = nodes.map(n => ({ ...n }))
  const nodeById = Object.fromEntries(simNodes.map(n => [n.id, n]))
  const simEdges = edges
    .map(e => ({ ...e, source: nodeById[e.source], target: nodeById[e.target] }))
    .filter(e => e.source && e.target)

  const svg = d3.select(container).append('svg')
    .attr('width', '100%').attr('height', '100%')

  svg.append('defs').append('marker')
    .attr('id', 'kg-arrow')
    .attr('viewBox', '0 -4 8 8')
    .attr('refX', 8).attr('refY', 0)
    .attr('markerWidth', 6).attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', '#2a5468')

  const g = svg.append('g')
  svg.call(d3.zoom().scaleExtent([0.15, 5]).on('zoom', ev => g.attr('transform', ev.transform)))

  const edgeLine = g.append('g').selectAll('line').data(simEdges).enter().append('line')
    .attr('stroke', '#1e3f54').attr('stroke-width', 1.5)
    .attr('marker-end', 'url(#kg-arrow)')

  const edgeLabel = g.append('g').selectAll('text').data(simEdges).enter().append('text')
    .text(d => d.type)
    .attr('font-size', '9px').attr('fill', '#2a5468')
    .attr('text-anchor', 'middle').attr('font-family', 'var(--font-mono)')
    .attr('pointer-events', 'none')

  const tooltip = d3.select(container).append('div').attr('class', 'graph-tooltip').style('display', 'none')

  const nodeGroup = g.append('g').selectAll('g').data(simNodes).enter().append('g')
    .attr('cursor', 'grab')
    .call(d3.drag()
      .on('start', (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y })
      .on('drag',  (ev, d) => { d.fx = ev.x; d.fy = ev.y })
      .on('end',   (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null })
    )

  nodeGroup.append('circle')
    .attr('r', R)
    .attr('fill',         d => nodeColor(d.labels[0]))
    .attr('stroke',       d => nodeColorStroke(d.labels[0]))
    .attr('stroke-width', 1.5)

  nodeGroup.append('text')
    .text(d => String(d.properties.name || d.properties.topic || `#${d.id}`).slice(0, 12))
    .attr('text-anchor', 'middle').attr('dy', '0.35em')
    .attr('font-size', '10px').attr('fill', '#d8eef5')
    .attr('font-family', 'var(--font-mono)').attr('pointer-events', 'none')

  nodeGroup.append('text')
    .text(d => d.labels[0] || '')
    .attr('text-anchor', 'middle').attr('dy', R + 14 + 'px')
    .attr('font-size', '8px').attr('fill', '#3d6878')
    .attr('font-family', 'var(--font-mono)').attr('pointer-events', 'none')

  nodeGroup
    .on('mouseover', (ev, d) => {
      const lines = Object.entries(d.properties).map(([k, v]) => `${k}: ${v}`).join('\n')
      tooltip.style('display', 'block')
        .html(`<strong>${escHtml(d.labels.join(' · '))}</strong><pre>${escHtml(lines)}</pre>`)
    })
    .on('mousemove', ev => {
      const rect = container.getBoundingClientRect()
      tooltip.style('left', (ev.clientX - rect.left + 14) + 'px').style('top', (ev.clientY - rect.top - 14) + 'px')
    })
    .on('mouseout', () => tooltip.style('display', 'none'))

  const sim = d3.forceSimulation(simNodes)
    .force('link',    d3.forceLink(simEdges).id(d => d.id).distance(130))
    .force('charge',  d3.forceManyBody().strength(-320))
    .force('center',  d3.forceCenter(width / 2, height / 2))
    .force('collide', d3.forceCollide(R + 18))
    .on('tick', () => {
      edgeLine
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => {
          const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y
          const dist = Math.sqrt(dx*dx + dy*dy) || 1
          return d.target.x - (dx / dist) * (R + 10)
        })
        .attr('y2', d => {
          const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y
          const dist = Math.sqrt(dx*dx + dy*dy) || 1
          return d.target.y - (dy / dist) * (R + 10)
        })
      edgeLabel
        .attr('x', d => (d.source.x + d.target.x) / 2)
        .attr('y', d => (d.source.y + d.target.y) / 2 - 5)
      nodeGroup.attr('transform', d => `translate(${d.x},${d.y})`)
    })
}


function tsStr(timestamp) {
  return new Date(timestamp).toISOString().slice(11, 23)
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function appendLog(event) {
  if (logEmpty?.parentNode) logEmpty.remove()

  if (logCount >= MAX_LOGS) {
    logStream.querySelector('.log-entry:last-child')?.remove()
    logCount--
  }

  const level = event.level || 'info'
  const entry = document.createElement('div')
  entry.className = 'log-entry'
  const data = event.data !== undefined
    ? `<span class="log-data">${JSON.stringify(event.data)}</span>`
    : ''
  entry.innerHTML = `
    <span class="log-ts">${tsStr(event.timestamp || Date.now())}</span>
    <span class="log-level ${level}">${level.toUpperCase()}</span>
    <span class="log-body">
      <span class="log-source">[${event.source || '?'}]</span><span class="log-msg ${level}">${escHtml(event.message || '')}</span>${data}
    </span>
  `
  logStream.prepend(entry)
  logCount++
  logCountEl.textContent = `${logCount} event${logCount !== 1 ? 's' : ''}`
}

// ─── Actor tree ───

const CHEVRON_DOWN  = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`
const CHEVRON_RIGHT = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`

function buildActorTree(actors) {
  const nodes = {}
  actors.forEach(a => {
    const parts = a.name.split('/')
    parts.forEach((_, i) => {
      const path  = parts.slice(0, i + 1).join('/')
      const label = parts[i]
      if (!nodes[path]) nodes[path] = { label, path, children: [], data: null }
    })
    nodes[a.name].data = a
  })
  const roots = []
  Object.values(nodes).forEach(node => {
    const parts = node.path.split('/')
    if (parts.length === 1) {
      roots.push(node)
    } else {
      const parentPath = parts.slice(0, -1).join('/')
      nodes[parentPath] ? nodes[parentPath].children.push(node) : roots.push(node)
    }
  })
  const sort = arr => { arr.sort((a, b) => a.label.localeCompare(b.label)); arr.forEach(n => sort(n.children)); return arr }
  return sort(roots)
}

function renderTreeNodes(nodes, depth) {
  return nodes.map(node => {
    const hasChildren = node.children.length > 0
    const isCollapsed = collapsedSet.has(node.path)
    const isSelected  = selectedActor === node.path
    const status      = node.data?.status || (hasChildren && !node.data ? null : 'running')
    const padLeft     = `${0.6 + depth * 1.1}rem`

    const chevron = hasChildren
      ? `<span class="tree-chevron" data-path="${node.path}">${isCollapsed ? CHEVRON_RIGHT : CHEVRON_DOWN}</span>`
      : `<span class="tree-spacer"></span>`

    const dot = status
      ? `<span class="tree-dot ${status}"></span>`
      : `<span class="tree-dot-empty"></span>`

    const count = node.data ? `<span class="tree-msg-count">${node.data.messagesProcessed ?? 0}</span>` : ''

    const children = hasChildren && !isCollapsed
      ? `<div class="tree-children">${renderTreeNodes(node.children, depth + 1)}</div>`
      : ''

    return `
      <div class="tree-node">
        <div class="tree-row${isSelected ? ' selected' : ''}" style="padding-left:${padLeft}" data-path="${node.path}" data-has-data="${!!node.data}">
          ${chevron}${dot}<span class="tree-label">${escHtml(node.label)}</span>${count}
        </div>
        ${children}
      </div>
    `
  }).join('')
}

function rerenderTree() {
  const roots = buildActorTree(Object.values(actorsMap))
  actorTreeEl.innerHTML = roots.length ? renderTreeNodes(roots, 0) : ''
}

// Event delegation — single listener for the whole tree
actorTreeEl.addEventListener('click', e => {
  const row = e.target.closest('.tree-row')
  if (!row) return
  const path    = row.dataset.path
  const hasData = row.dataset.hasData === 'true'

  if (e.target.closest('.tree-chevron')) {
    collapsedSet.has(path) ? collapsedSet.delete(path) : collapsedSet.add(path)
    rerenderTree()
    return
  }

  if (hasData) {
    selectedActor = path
    rerenderTree()
    renderActorDetail(actorsMap[path])
  } else {
    collapsedSet.has(path) ? collapsedSet.delete(path) : collapsedSet.add(path)
    rerenderTree()
  }
})

function renderActorDetail(actor) {
  if (!actor) {
    actorDetailEl.innerHTML = `
      <div class="empty-panel">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
        </svg>
        <span>select an actor to inspect</span>
      </div>`
    return
  }

  const status = actor.status || 'running'
  const failed = actor.messagesFailed ?? 0
  const avg    = typeof actor.processingTime?.avg === 'number' ? actor.processingTime.avg.toFixed(2) : '—'
  const min    = typeof actor.processingTime?.min === 'number' ? actor.processingTime.min.toFixed(2) : '—'
  const max    = typeof actor.processingTime?.max === 'number' ? actor.processingTime.max.toFixed(2) : '—'

  const parts = actor.name.split('/')
  const breadcrumb = parts.map((p, i) =>
    i < parts.length - 1
      ? `<span class="crumb">${escHtml(p)}</span><span class="crumb-sep">/</span>`
      : `<span class="crumb active">${escHtml(p)}</span>`
  ).join('')

  const stateSection = actor.state !== undefined && actor.state !== null
    ? `<div class="detail-section-label">state</div>
       <pre class="detail-state">${escHtml(JSON.stringify(actor.state, null, 2))}</pre>`
    : ''

  actorDetailEl.innerHTML = `
    <div class="detail-head">
      <div class="detail-path">${breadcrumb}</div>
      <span class="actor-status ${status}">${status}</span>
    </div>
    <div class="detail-divider"></div>
    <div class="detail-section-label">messages</div>
    <div class="detail-grid">
      <div class="detail-stat">
        <span class="ds-val">${actor.messagesReceived ?? 0}</span>
        <span class="ds-key">received</span>
      </div>
      <div class="detail-stat">
        <span class="ds-val">${actor.messagesProcessed ?? 0}</span>
        <span class="ds-key">processed</span>
      </div>
      <div class="detail-stat${failed > 0 ? ' error' : ''}">
        <span class="ds-val${failed > 0 ? ' error' : ''}">${failed}</span>
        <span class="ds-key">failed</span>
      </div>
      <div class="detail-stat">
        <span class="ds-val">${actor.mailboxSize ?? 0}</span>
        <span class="ds-key">mailbox</span>
      </div>
    </div>
    <div class="detail-section-label">processing time</div>
    <div class="detail-grid three">
      <div class="detail-stat">
        <span class="ds-val sm">${avg} <span class="ds-unit">ms</span></span>
        <span class="ds-key">average</span>
      </div>
      <div class="detail-stat">
        <span class="ds-val sm">${min} <span class="ds-unit">ms</span></span>
        <span class="ds-key">minimum</span>
      </div>
      <div class="detail-stat">
        <span class="ds-val sm">${max} <span class="ds-unit">ms</span></span>
        <span class="ds-key">maximum</span>
      </div>
    </div>
    ${stateSection}
  `
}

function updateMetrics(event) {
  if (metricsEmpty?.parentNode) metricsEmpty.remove()

  const actors = event.actors || []
  let totRecv = 0, totDone = 0, totFail = 0
  actors.forEach(a => {
    totRecv += a.messagesReceived || 0
    totDone += a.messagesProcessed || 0
    totFail += a.messagesFailed || 0
    actorsMap[a.name] = a
  })

  const seen = new Set(actors.map(a => a.name))
  Object.keys(actorsMap).forEach(k => { if (!seen.has(k)) delete actorsMap[k] })
  if (selectedActor && !actorsMap[selectedActor]) selectedActor = null

  if (actors.length > 0) {
    const isMetricsActive = !!document.querySelector('.obs-subtab[data-subtab="metrics"].active')
    metricsSummary.style.display = isMetricsActive ? 'flex' : 'none'
    sumActors.textContent = actors.length
    sumRecv.textContent   = totRecv
    sumDone.textContent   = totDone
    sumFail.textContent   = totFail
  }

  rerenderTree()
  if (selectedActor && actorsMap[selectedActor]) {
    renderActorDetail(actorsMap[selectedActor])
  }

  if (event.topics) updateTopics(event.topics)
}

function renderTopicEntry(t, label) {
  const displayLabel = label ?? t.topic
  const isExpanded = expandedTopics.has(t.topic)
  const subCount = t.subscribers.length
  const chevron = subCount > 0
    ? `<span class="tree-chevron topic-chevron" data-topic="${escHtml(t.topic)}">${isExpanded ? CHEVRON_DOWN : CHEVRON_RIGHT}</span>`
    : `<span class="tree-spacer"></span>`
  const subs = isExpanded && subCount > 0
    ? `<div class="topic-subscribers">${t.subscribers.map(s =>
        `<div class="topic-sub-row"><span class="topic-sub-name">${escHtml(s)}</span></div>`
      ).join('')}</div>`
    : ''
  return `
    <div class="topic-entry">
      <div class="topic-row" data-topic="${escHtml(t.topic)}" data-has-subs="${subCount > 0}">
        ${chevron}
        <span class="topic-name">${escHtml(displayLabel)}</span>
        <span class="topic-sub-count">${subCount}</span>
      </div>
      ${subs}
    </div>`
}

function updateTopics(topics) {
  if (topicsEmpty?.parentNode) topicsEmpty.remove()
  topicsData = topics

  if (topics.length === 0) {
    topicListEl.innerHTML = `<div class="empty-panel"><span>no active topics</span></div>`
    return
  }

  const watchTopics = topics.filter(t => t.topic.startsWith('$watch:'))
  const otherTopics = topics.filter(t => !t.topic.startsWith('$watch:'))

  let watchHtml = ''
  if (watchTopics.length > 0) {
    const isGroupExpanded = expandedTopics.has('$watch')
    const childrenHtml = isGroupExpanded
      ? `<div class="topic-children">${watchTopics.map(t => renderTopicEntry(t, t.topic.slice('$watch:'.length))).join('')}</div>`
      : ''
    watchHtml = `
      <div class="topic-entry">
        <div class="topic-row topic-group" data-topic="$watch" data-has-subs="true">
          <span class="tree-chevron topic-chevron" data-topic="$watch">${isGroupExpanded ? CHEVRON_DOWN : CHEVRON_RIGHT}</span>
          <span class="topic-name">$watch</span>
          <span class="topic-sub-count">${watchTopics.length}</span>
        </div>
        ${childrenHtml}
      </div>`
  }

  topicListEl.innerHTML = watchHtml + otherTopics.map(t => renderTopicEntry(t)).join('')
}

topicListEl.addEventListener('click', e => {
  const row = e.target.closest('.topic-row')
  if (!row || row.dataset.hasSubs !== 'true') return
  const topic = row.dataset.topic
  expandedTopics.has(topic) ? expandedTopics.delete(topic) : expandedTopics.add(topic)
  updateTopics(topicsData)
})

clearBtn.addEventListener('click', () => {
  logStream.querySelectorAll('.log-entry').forEach(el => el.remove())
  logCount = 0
  logCountEl.textContent = '0 events'
  if (!logStream.querySelector('.empty-panel')) {
    const empty = document.createElement('div')
    empty.className = 'empty-panel'
    empty.innerHTML = `
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
        <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
      </svg>
      <span>awaiting log events</span>
    `
    logStream.appendChild(empty)
  }
})

// ─── Config tabs ───

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

// ─── Config ───

const configForm = document.getElementById('config-form')
const saveStatus = document.getElementById('save-status')
const saveError  = document.getElementById('save-error')
const resetBtn   = document.getElementById('reset-btn')

const configDefaults = {
  logPath: 'logs/app.jsonl',
  minLevel: 'debug',
  flushIntervalMs: 3000,
  metricsIntervalMs: 5000,
  metricsEnabled: true,
  model: 'openai/gpt-4o-mini',
  systemPrompt: '',
  historyWindow: 40,
  reasoningEnabled: false,
  reasoningEffort: 'medium',
  visionModel: 'google/gemini-flash-1.5',
  audioModel: '',
  audioVoice: 'alloy',
  bashCwd: '/workspace',
  webSearchCount: 20,
  kgraphDbPath: './workspace/memory/kgraph',
  memoryModel: '',
  memoryUserId: 'default',
  memoryConsolidationIntervalMs: 30000,
}

function loadConfig() {
  try {
    return { ...configDefaults, ...JSON.parse(localStorage.getItem('rorschach-config') || '{}') }
  } catch { return { ...configDefaults } }
}

function applyToForm(cfg) {
  configForm.logPath.value                    = cfg.logPath
  configForm.minLevel.value                   = cfg.minLevel
  configForm.flushIntervalMs.value            = cfg.flushIntervalMs
  configForm.metricsIntervalMs.value          = cfg.metricsIntervalMs
  configForm.metricsEnabled.checked           = cfg.metricsEnabled
  configForm.model.value                      = cfg.model
  configForm.systemPrompt.value               = cfg.systemPrompt ?? ''
  configForm.historyWindow.value              = cfg.historyWindow ?? 40
  configForm.reasoningEnabled.checked         = cfg.reasoningEnabled
  configForm.reasoningEffort.value            = cfg.reasoningEffort
  configForm.visionModel.value                = cfg.visionModel
  configForm.audioModel.value                 = cfg.audioModel ?? ''
  configForm.audioVoice.value                 = cfg.audioVoice ?? 'alloy'
  configForm.bashCwd.value                    = cfg.bashCwd ?? '/workspace'
  configForm.webSearchCount.value             = cfg.webSearchCount ?? 20
  configForm.kgraphDbPath.value               = cfg.kgraphDbPath ?? './workspace/memory/kgraph'
  configForm.memoryModel.value                = cfg.memoryModel ?? ''
  configForm.memoryUserId.value               = cfg.memoryUserId ?? 'default'
  configForm.memoryConsolidationIntervalMs.value = cfg.memoryConsolidationIntervalMs ?? 30000
}

function readFromForm() {
  return {
    logPath:                      configForm.logPath.value.trim(),
    minLevel:                     configForm.minLevel.value,
    flushIntervalMs:              Number(configForm.flushIntervalMs.value),
    metricsIntervalMs:            Number(configForm.metricsIntervalMs.value),
    metricsEnabled:               configForm.metricsEnabled.checked,
    model:                        configForm.model.value,
    systemPrompt:                 configForm.systemPrompt.value,
    historyWindow:                Number(configForm.historyWindow.value),
    reasoningEnabled:             String(configForm.reasoningEnabled.checked),
    reasoningEffort:              configForm.reasoningEffort.value,
    visionModel:                  configForm.visionModel.value,
    audioModel:                   configForm.audioModel.value,
    audioVoice:                   configForm.audioVoice.value,
    bashCwd:                      configForm.bashCwd.value.trim(),
    webSearchCount:               Number(configForm.webSearchCount.value),
    kgraphDbPath:                 configForm.kgraphDbPath.value.trim(),
    memoryModel:                  configForm.memoryModel.value,
    memoryUserId:                 configForm.memoryUserId.value.trim(),
    memoryConsolidationIntervalMs: Number(configForm.memoryConsolidationIntervalMs.value),
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
  localStorage.setItem('rorschach-config', JSON.stringify(cfg))
  try {
    const res = await fetch(new URL('config', location.href), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    })
    if (!res.ok) throw new Error(`server error ${res.status}`)
    flashSaved()
  } catch (err) {
    flashError(err.message)
  }
})

resetBtn.addEventListener('click', () => applyToForm(configDefaults))

// ─── Dynamic model list ───

async function initModelSelects() {
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

  const cfg = loadConfig()

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

// ─── Boot ───
initModelSelects().then(() => applyToForm(loadConfig()))
connect()
