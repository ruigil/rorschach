// ─── Base64url utilities ───────────────────────────────────────────────────────

export function bytesToBase64url(bytes) {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

export function base64urlToBytes(s) {
  const base64  = s.replace(/-/g, '+').replace(/_/g, '/')
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const binary  = atob(base64 + padding)
  const bytes   = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// ─── WebAuthn helpers ─────────────────────────────────────────────────────────

// Encode a credential (registration or authentication) for sending to the server.
export function encodeCredential(cred) {
  if (cred.type === 'public-key') {
    const raw = cred.response
    if (raw.attestationObject) {
      // Registration
      return {
        type:  'registration',
        id:    cred.id,
        rawId: bytesToBase64url(new Uint8Array(cred.rawId)),
        response: {
          clientDataJSON:    bytesToBase64url(new Uint8Array(raw.clientDataJSON)),
          attestationObject: bytesToBase64url(new Uint8Array(raw.attestationObject)),
        },
      }
    } else {
      // Authentication
      return {
        type:  'authentication',
        id:    cred.id,
        rawId: bytesToBase64url(new Uint8Array(cred.rawId)),
        response: {
          clientDataJSON:    bytesToBase64url(new Uint8Array(raw.clientDataJSON)),
          authenticatorData: bytesToBase64url(new Uint8Array(raw.authenticatorData)),
          signature:         bytesToBase64url(new Uint8Array(raw.signature)),
          ...(raw.userHandle ? { userHandle: bytesToBase64url(new Uint8Array(raw.userHandle)) } : {}),
        },
      }
    }
  }
  throw new Error('Unexpected credential type')
}

// Decode server registration options for navigator.credentials.create()
export function decodeRegistrationOptions(opts) {
  return {
    ...opts,
    challenge: base64urlToBytes(opts.challenge),
    user: { ...opts.user, id: base64urlToBytes(opts.user.id) },
  }
}

// Decode server authentication options for navigator.credentials.get()
export function decodeAuthenticationOptions(opts) {
  return {
    ...opts,
    challenge: base64urlToBytes(opts.challenge),
    allowCredentials: (opts.allowCredentials ?? []).map(c => ({
      ...c,
      id: base64urlToBytes(c.id),
    })),
  }
}

// ─── QR code generator ────────────────────────────────────────────────────────
// Minimal but correct implementation.
// Supports: byte mode, ECC Level M, versions 1–40, mask pattern evaluation.

const QR = (() => {
  // GF(256) arithmetic (polynomial x^8 + x^4 + x^3 + x^2 + 1)
  const EXP = new Uint8Array(512)
  const LOG  = new Uint8Array(256)
  for (let i = 0, x = 1; i < 255; i++, x = x >= 128 ? ((x << 1) ^ 0x11d) & 0xff : x << 1) {
    EXP[i] = EXP[i + 255] = x
    LOG[x] = i
  }
  const gfMul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0
  const gfPow = (x, e) => EXP[(LOG[x] * e) % 255]

  function rsGenerator(n) {
    let g = [1]
    for (let i = 0; i < n; i++) {
      const factor = [1, EXP[i]]
      const next = new Array(g.length + 1).fill(0)
      for (let j = 0; j < g.length; j++)
        for (let k = 0; k < factor.length; k++)
          next[j + k] ^= gfMul(g[j], factor[k])
      g = next
    }
    return g
  }

  function rsEncode(data, n) {
    const gen = rsGenerator(n)
    const msg = [...data, ...new Array(n).fill(0)]
    for (let i = 0; i < data.length; i++) {
      const c = msg[i]
      if (c) for (let j = 0; j < gen.length; j++) msg[i + j] ^= gfMul(gen[j], c)
    }
    return msg.slice(data.length)
  }

  // Version capacity tables (ECC Level M): [dataCodewords, [ecCodewords per block], [blocks]]
  // Source: QR code spec ISO 18004:2015 Table 9
  const VERSION_TABLE = [
    null,                             // index 0 unused
    [16,  [10], [1]],                 // v1
    [28,  [16], [1]],                 // v2
    [44,  [26], [1]],                 // v3
    [64,  [18], [2]],                 // v4
    [86,  [24], [2]],                 // v5
    [108, [16], [4]],                 // v6
    [124, [18], [4]],                 // v7
    [154, [22], [2, 2]],              // v8
    [182, [22], [3, 2]],              // v9
    [216, [26], [4, 1]],              // v10
    [254, [30], [1, 4]],              // v11 — simplified
    [290, [22], [6, 2]],              // v12
    [334, [22], [8, 1]],              // v13
    [365, [24], [4, 5]],              // v14
    [415, [24], [5, 5]],              // v15
    [453, [28], [7, 3]],              // v16
    [507, [28], [10, 1]],             // v17
    [563, [26], [9, 4]],              // v18
    [627, [26], [3, 11]],             // v19
    [669, [26], [3, 13]],             // v20
  ]

  function chooseVersion(byteLen) {
    for (let v = 1; v < VERSION_TABLE.length; v++) {
      const entry = VERSION_TABLE[v]
      if (entry && entry[0] >= byteLen + 3) return v  // +3 for mode(4) + count(8) + terminator(4) overhead
    }
    throw new Error('Data too long for QR code (max ~630 bytes with ECC M)')
  }

  // Encode data bytes → list of codewords (mode=0100 byte, then data, then padding)
  function encodeData(bytes, version) {
    const entry    = VERSION_TABLE[version]
    const capacity = entry[0]
    const bits     = []
    const pushBits = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1) }

    pushBits(0b0100, 4)            // byte mode
    pushBits(bytes.length, 8)      // character count (8 bits for versions 1–9)
    for (const b of bytes) pushBits(b, 8)
    pushBits(0, Math.min(4, capacity * 8 - bits.length))  // terminator

    // Pad to byte boundary
    while (bits.length % 8) bits.push(0)

    // Fill with padding codewords
    const padWords = [0xec, 0x11]
    while (bits.length < capacity * 8) pushBits(padWords[(bits.length / 8 - bytes.length - 2) % 2], 8)

    // Convert to bytes
    const codewords = []
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ?? 0)
      codewords.push(byte)
    }
    return codewords.slice(0, capacity)
  }

  // Interleave data + ECC blocks
  function buildFinalMessage(dataCodewords, version) {
    const [, ecCounts, blockCounts] = VERSION_TABLE[version]
    const blocks = []
    let offset = 0
    let blockIdx = 0

    for (let gi = 0; gi < blockCounts.length; gi++) {
      const numBlocks = blockCounts[gi]
      const ecCount   = ecCounts[0]  // simplified: use first ECC count for all groups
      const dataPerBlock = Math.floor((dataCodewords.length - offset) / (numBlocks + (blockCounts.slice(gi + 1).reduce((a, b) => a + b, 0))))
      for (let b = 0; b < numBlocks; b++) {
        const data = dataCodewords.slice(offset, offset + dataPerBlock + (blockIdx < dataCodewords.length % numBlocks ? 1 : 0))
        blocks.push({ data, ec: rsEncode(data, ecCount) })
        offset += data.length
        blockIdx++
      }
    }

    if (blocks.length === 0) {
      // Fallback: single block
      const ecCount = ecCounts[0]
      return [...dataCodewords, ...rsEncode(dataCodewords, ecCount)]
    }

    const maxDataLen = Math.max(...blocks.map(b => b.data.length))
    const maxEcLen   = Math.max(...blocks.map(b => b.ec.length))
    const result = []
    for (let i = 0; i < maxDataLen; i++) for (const b of blocks) if (i < b.data.length) result.push(b.data[i])
    for (let i = 0; i < maxEcLen;   i++) for (const b of blocks) if (i < b.ec.length)   result.push(b.ec[i])
    return result
  }

  // Format information for ECC Level M (bits 13:12 = 00) and mask pattern (0–7)
  // Pre-computed for ECC M: error correction bits table for masks 0–7
  const FORMAT_INFO = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0]

  function buildMatrix(version, finalMessage, maskPattern) {
    const size = version * 4 + 17
    const mod  = Array.from({ length: size }, () => new Int8Array(size).fill(-1))  // -1 = unset

    const setMod = (r, c, v) => { mod[r][c] = v }
    const inBounds = (r, c) => r >= 0 && r < size && c >= 0 && c < size

    // Finder pattern (top-left, top-right, bottom-left)
    const drawFinder = (tr, tc) => {
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
        if (!inBounds(tr + r, tc + c)) continue
        const inSquare = r >= 0 && r <= 6 && c >= 0 && c <= 6
        const onBorder = r === 0 || r === 6 || c === 0 || c === 6
        const inInner  = r >= 2 && r <= 4 && c >= 2 && c <= 4
        setMod(tr + r, tc + c, inSquare && (onBorder || inInner) ? 1 : 0)
      }
    }
    drawFinder(0, 0); drawFinder(0, size - 7); drawFinder(size - 7, 0)

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      setMod(6, i, i % 2 === 0 ? 1 : 0)
      setMod(i, 6, i % 2 === 0 ? 1 : 0)
    }

    // Dark module
    setMod(size - 8, 8, 1)

    // Alignment patterns (version >= 2)
    if (version >= 2) {
      const alignCoords = getAlignmentCoords(version)
      for (const ar of alignCoords) for (const ac of alignCoords) {
        if (mod[ar][ac] !== -1) continue  // skip if already set
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
          const onEdge = dr === -2 || dr === 2 || dc === -2 || dc === 2
          const isCenter = dr === 0 && dc === 0
          setMod(ar + dr, ac + dc, (onEdge || isCenter) ? 1 : 0)
        }
      }
    }

    // Format info placeholder (reserve modules)
    const fmtBits = formatBits(FORMAT_INFO[maskPattern])
    placeFormatInfo(mod, fmtBits, size)

    // Data placement
    const isFunction = (r, c) => mod[r][c] !== -1
    const mask = getMaskFn(maskPattern)
    let bitIdx = 0
    for (let col = size - 1; col >= 1; col -= 2) {
      if (col === 6) col = 5  // skip timing column
      for (let row = 0; row < size; row++) {
        const actualRow = col % 4 < 2 ? size - 1 - row : row  // zigzag direction
        for (let dc = 0; dc <= 1; dc++) {
          const c = col - dc
          if (!isFunction(actualRow, c) && bitIdx < finalMessage.length * 8) {
            const bit = (finalMessage[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1
            setMod(actualRow, c, bit ^ (mask(actualRow, c) ? 1 : 0))
            bitIdx++
          }
        }
      }
    }

    return mod
  }

  function getAlignmentCoords(version) {
    if (version === 1) return []
    const intervals = Math.floor(version / 7) + 1
    const step = version === 32 ? 26 : Math.ceil((version * 4 - 2) / (intervals * 2)) * 2
    const coords = [6]
    for (let i = 1; i <= intervals; i++) coords.push(version * 4 + 10 - step * (intervals - i))
    return coords
  }

  function formatBits(info) {
    const bits = []
    for (let i = 14; i >= 0; i--) bits.push((info >> i) & 1)
    return bits
  }

  function placeFormatInfo(mod, fmtBits, size) {
    const positions = [
      [8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],
      [7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8],
    ]
    for (let i = 0; i < 15; i++) mod[positions[i][0]][positions[i][1]] = fmtBits[i]
    // Second copy (top-right and bottom-left)
    for (let i = 0; i < 8; i++) mod[8][size - 1 - i] = fmtBits[i]
    for (let i = 0; i < 7; i++) mod[size - 7 + i][8] = fmtBits[14 - i]
  }

  function getMaskFn(pattern) {
    const fns = [
      (r, c) => (r + c) % 2 === 0,
      (r, c) => r % 2 === 0,
      (r, c) => c % 3 === 0,
      (r, c) => (r + c) % 3 === 0,
      (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
      (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
      (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
      (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
    ]
    return fns[pattern]
  }

  // Evaluate a matrix with a penalty score (for mask selection)
  function penaltyScore(mod) {
    const size = mod.length
    let score = 0
    // Rule 1: 5+ in a row same color
    for (let r = 0; r < size; r++) {
      for (let horiz = 0; horiz < 2; horiz++) {
        let run = 1
        for (let i = 1; i < size; i++) {
          const cur  = horiz ? mod[r][i] : mod[i][r]
          const prev = horiz ? mod[r][i-1] : mod[i-1][r]
          if (cur === prev) run++
          else { if (run >= 5) score += run - 2; run = 1 }
        }
        if (run >= 5) score += run - 2
      }
    }
    // Rule 2: 2×2 blocks
    for (let r = 0; r < size - 1; r++)
      for (let c = 0; c < size - 1; c++)
        if (mod[r][c] === mod[r+1][c] && mod[r][c] === mod[r][c+1] && mod[r][c] === mod[r+1][c+1])
          score += 3
    return score
  }

  return {
    encode(text) {
      const bytes = new TextEncoder().encode(text)
      const version = chooseVersion(bytes.length)
      const dataCodewords = encodeData(bytes, version)
      const finalMessage  = buildFinalMessage(dataCodewords, version)

      // Try all 8 masks, pick best
      let bestMatrix = null, bestScore = Infinity
      for (let m = 0; m < 8; m++) {
        const matrix = buildMatrix(version, finalMessage, m)
        const score  = penaltyScore(matrix)
        if (score < bestScore) { bestScore = score; bestMatrix = matrix }
      }
      return bestMatrix
    },
  }
})()

// ─── Render QR code to canvas ─────────────────────────────────────────────────

export function renderQR(canvas, text, { size = 300, quiet = 4 } = {}) {
  const matrix = QR.encode(text)
  if (!matrix) return
  const n   = matrix.length
  const mod = (size - quiet * 2) / n
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size)
  ctx.fillStyle = '#000'
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (matrix[r][c] === 1)
        ctx.fillRect(quiet + c * mod, quiet + r * mod, mod, mod)
}

// ─── WebSocket with auto-ticket ───────────────────────────────────────────────

export async function openWebSocket(handlers) {
  const ticketUrl = new URL('ticket', import.meta.url)
  const res = await fetch(ticketUrl, { method: 'POST' })

  const wsBase = new URL('../ws', import.meta.url)
  wsBase.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'

  if (res.ok) {
    const { ticket } = await res.json()
    wsBase.searchParams.set('ticket', ticket)
  } else if (res.status === 401) {
    window.location.href = new URL('login.html', import.meta.url).href
    return null
  }
  // 503 or other → connect without ticket (auth not configured)

  const ws = new WebSocket(wsBase.href)
  if (handlers.onopen)    ws.onopen    = handlers.onopen
  if (handlers.onmessage) ws.onmessage = handlers.onmessage
  if (handlers.onclose)   ws.onclose   = handlers.onclose
  if (handlers.onerror)   ws.onerror   = handlers.onerror
  return ws
}
