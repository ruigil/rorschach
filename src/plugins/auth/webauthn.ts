import type { AuthConfig } from './auth.config.ts'
import type { WebAuthnCredential, DeviceKey } from './types.ts'

// ─── Base64url ───

export const bytesToBase64url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

export const base64urlToBytes = (s: string): Uint8Array => {
  const base64  = s.replace(/-/g, '+').replace(/_/g, '/')
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const binary  = atob(base64 + padding)
  const bytes   = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// ─── Token helpers ───

export const generateToken = (): string => {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)))
}

// ─── Minimal CBOR decoder (WebAuthn subset) ───
// Supports major types 0–5 with definite lengths.
// Sufficient for attestationObject and COSE key maps.

export const decodeCbor = (data: Uint8Array, offset = 0): [unknown, number] => {
  const byte      = data[offset++]!
  const majorType = (byte >> 5) & 0x07
  const info      = byte & 0x1f

  let length = 0
  if (info < 24) {
    length = info
  } else if (info === 24) {
    length = data[offset++]!
  } else if (info === 25) {
    length = (data[offset]! << 8) | data[offset + 1]!; offset += 2
  } else if (info === 26) {
    length = ((data[offset]! << 24) | (data[offset+1]! << 16) | (data[offset+2]! << 8) | data[offset+3]!) >>> 0
    offset += 4
  } else {
    throw new Error(`CBOR: unsupported additional info ${info}`)
  }

  switch (majorType) {
    case 0: return [length, offset]
    case 1: return [-1 - length, offset]
    case 2: { const b = data.slice(offset, offset + length); return [b, offset + length] }
    case 3: { const t = new TextDecoder().decode(data.slice(offset, offset + length)); return [t, offset + length] }
    case 4: {
      const arr: unknown[] = []
      for (let i = 0; i < length; i++) { let v: unknown; [v, offset] = decodeCbor(data, offset); arr.push(v) }
      return [arr, offset]
    }
    case 5: {
      const map: Record<string | number, unknown> = {}
      for (let i = 0; i < length; i++) {
        let k: unknown, v: unknown
        ;[k, offset] = decodeCbor(data, offset)
        ;[v, offset] = decodeCbor(data, offset)
        map[k as string | number] = v
      }
      return [map, offset]
    }
    default: throw new Error(`CBOR: unsupported major type ${majorType}`)
  }
}

// ─── AuthData parser ───

type ParsedAuthData = {
  rpIdHash:      Uint8Array
  flags:         number
  signCount:     number
  credentialId?: Uint8Array
  coseKey?:      Uint8Array
}

const readUint16BE = (data: Uint8Array, offset: number): number => {
  return (data[offset]! << 8) | data[offset + 1]!
}

const readUint32BE = (data: Uint8Array, offset: number): number => {
  return ((data[offset]! << 24) | (data[offset+1]! << 16) | (data[offset+2]! << 8) | data[offset+3]!) >>> 0
}

export const parseAuthData = (authData: Uint8Array): ParsedAuthData => {
  const rpIdHash  = authData.slice(0, 32)
  const flags     = authData[32] ?? 0
  const signCount = readUint32BE(authData, 33)

  const AT_FLAG = 0x40
  if (!(flags & AT_FLAG)) return { rpIdHash, flags, signCount }

  // aaguid at 37–52 (16 bytes), skip it
  const credIdLenOffset  = 53
  const credentialIdLen  = readUint16BE(authData, credIdLenOffset)
  const credIdStart      = credIdLenOffset + 2
  const credIdEnd        = credIdStart + credentialIdLen
  const credentialId     = authData.slice(credIdStart, credIdEnd)
  const coseKey          = authData.slice(credIdEnd)   // rest is CBOR-encoded COSE key

  return { rpIdHash, flags, signCount, credentialId, coseKey }
}

// ─── DER → IEEE P1363 conversion (for ECDSA signature) ───

export const derToP1363 = (sig: Uint8Array): Uint8Array => {
  let off = 0
  if (sig[off++] !== 0x30) throw new Error('DER: expected SEQUENCE')
  // skip sequence length
  if ((sig[off]! & 0x80) !== 0) off += (sig[off]! & 0x7f) + 1; else off++
  // r
  if (sig[off++] !== 0x02) throw new Error('DER: expected INTEGER (r)')
  const rLen = sig[off++]!; let r = sig.slice(off, off + rLen); off += rLen
  // s
  if (sig[off++] !== 0x02) throw new Error('DER: expected INTEGER (s)')
  const sLen = sig[off++]!; let s = sig.slice(off, off + sLen)
  // strip leading 0x00 padding bytes
  while (r.length > 32 && r[0] === 0) r = r.slice(1)
  while (s.length > 32 && s[0] === 0) s = s.slice(1)
  const out = new Uint8Array(64)
  out.set(r, 32 - r.length)
  out.set(s, 64 - s.length)
  return out
}

// ─── COSE key → CryptoKey ───

export const importCoseKey = async (coseKeyBytes: Uint8Array): Promise<{ key: CryptoKey; kty: number }> => {
  const [rawMap] = decodeCbor(coseKeyBytes)
  const coseMap  = rawMap as Record<number, unknown>
  const kty      = coseMap[1] as number

  if (kty === 2) {  // EC2 / P-256
    const x     = coseMap[-2] as Uint8Array
    const y     = coseMap[-3] as Uint8Array
    const point = new Uint8Array(65)
    point[0] = 0x04
    point.set(x, 1)
    point.set(y, 33)
    const key = await crypto.subtle.importKey(
      'raw', point, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
    )
    return { key, kty }
  }

  throw new Error(`Unsupported COSE key type: ${kty}. Only EC2 P-256 is supported.`)
}

// ─── WebAuthn verification ───

export const verifyRegistration = async (
  challengeValue: string,
  credential: Extract<WebAuthnCredential, { type: 'registration' }>,
  config: AuthConfig,
): Promise<{ credentialId: string; publicKey: string; counter: number }> => {
  const { response } = credential

  // 1. Verify clientDataJSON
  const clientDataBytes = base64urlToBytes(response.clientDataJSON)
  const clientData      = JSON.parse(new TextDecoder().decode(clientDataBytes)) as Record<string, string>
  if (clientData.type      !== 'webauthn.create') throw new Error('invalid clientData type')
  if (clientData.challenge !== challengeValue)    throw new Error('challenge mismatch')
  if (clientData.origin    !== config.origin)     throw new Error(`origin mismatch: got ${clientData.origin}`)

  // 2. Decode attestationObject
  const attestBytes = base64urlToBytes(response.attestationObject)
  const [rawAttest] = decodeCbor(attestBytes)
  const attestObj   = rawAttest as Record<string, unknown>
  const fmt         = attestObj['fmt'] as string
  const authData    = attestObj['authData'] as Uint8Array
  if (fmt !== 'none') throw new Error(`Unsupported attestation format: ${fmt}`)

  // 3. Parse authData
  const parsed = parseAuthData(authData)
  if (!parsed.credentialId || !parsed.coseKey) throw new Error('missing attested credential data')

  // 4. Verify rpId hash
  const expectedHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(config.rpId)),
  )
  if (!parsed.rpIdHash.every((b, i) => b === expectedHash[i])) throw new Error('rpId hash mismatch')

  // 5. Check User Present flag
  if (!(parsed.flags & 0x01)) throw new Error('user not present')

  return {
    credentialId: bytesToBase64url(parsed.credentialId),
    publicKey:    bytesToBase64url(parsed.coseKey),
    counter:      parsed.signCount,
  }
}

export const verifyAuthentication = async (
  challengeValue: string,
  credential: Extract<WebAuthnCredential, { type: 'authentication' }>,
  deviceKey: DeviceKey,
  config: AuthConfig,
): Promise<{ newCounter: number }> => {
  const { response } = credential

  // 1. Verify clientDataJSON
  const clientDataBytes = base64urlToBytes(response.clientDataJSON)
  const clientData      = JSON.parse(new TextDecoder().decode(clientDataBytes)) as Record<string, string>
  if (clientData.type      !== 'webauthn.get') throw new Error('invalid clientData type')
  if (clientData.challenge !== challengeValue) throw new Error('challenge mismatch')
  if (clientData.origin    !== config.origin)  throw new Error(`origin mismatch: got ${clientData.origin}`)

  // 2. Parse authenticatorData
  const authData = base64urlToBytes(response.authenticatorData)
  const parsed   = parseAuthData(authData)

  // 3. Verify rpId hash
  const expectedHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(config.rpId)),
  )
  if (!parsed.rpIdHash.every((b, i) => b === expectedHash[i])) throw new Error('rpId hash mismatch')

  // 4. Check User Present flag
  if (!(parsed.flags & 0x01)) throw new Error('user not present')

  // 5. Verify signCount (allow 0 for software authenticators that don't increment)
  if (parsed.signCount > 0 && parsed.signCount <= deviceKey.counter) {
    throw new Error('signCount too low — possible cloned authenticator')
  }

  // 6. Verify signature
  const coseKeyBytes  = base64urlToBytes(deviceKey.publicKey)
  const { key, kty }  = await importCoseKey(coseKeyBytes)
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataBytes as unknown as ArrayBuffer))
  const sigBase = new Uint8Array(authData.length + clientDataHash.length)
  sigBase.set(authData)
  sigBase.set(clientDataHash, authData.length)

  const rawSig = base64urlToBytes(response.signature)
  const sigToVerify: ArrayBuffer = (kty === 2 ? derToP1363(rawSig) : rawSig) as unknown as ArrayBuffer
  const alg = kty === 2
    ? { name: 'ECDSA', hash: 'SHA-256' } as AlgorithmIdentifier
    : { name: 'RSASSA-PKCS1-v1_5' }     as AlgorithmIdentifier

  const valid = await crypto.subtle.verify(alg, key, sigToVerify, sigBase)
  if (!valid) throw new Error('signature verification failed')

  return { newCounter: parsed.signCount }
}
