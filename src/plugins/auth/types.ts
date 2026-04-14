import { createTopic } from '../../system/types.ts'
import type { ActorRef } from '../../system/types.ts'

// ─── IDs ───

export type UserId       = string
export type CredentialId = string   // base64url

// ─── WebAuthn wire types ───
// Mirror the browser's PublicKeyCredential serialisation.
// crypto.subtle handles all signature verification (Bun built-in).

export type AuthenticatorAttestationResponseJSON = {
  clientDataJSON:    string   // base64url
  attestationObject: string   // base64url
}

export type AuthenticatorAssertionResponseJSON = {
  clientDataJSON:    string   // base64url
  authenticatorData: string   // base64url
  signature:         string   // base64url
  userHandle?:       string   // base64url
}

export type WebAuthnCredential =
  | { type: 'registration';   id: CredentialId; rawId: string; response: AuthenticatorAttestationResponseJSON }
  | { type: 'authentication'; id: CredentialId; rawId: string; response: AuthenticatorAssertionResponseJSON }

export type RegistrationOptions = {
  challenge:             string   // base64url
  rp:                    { id: string; name: string }
  user:                  { id: string; name: string; displayName: string }
  pubKeyCredParams:      Array<{ type: 'public-key'; alg: number }>
  timeout:               number
  attestation:           'none'
  authenticatorSelection: {
    residentKey:       'required'
    userVerification:  'required'
  }
}

export type RegistrationBeginResult = {
  challengeId: string
  options:     RegistrationOptions
}

export type AuthenticationOptions = {
  challenge:        string   // base64url
  rpId:             string
  timeout:          number
  allowCredentials: Array<{ type: 'public-key'; id: string }>
  userVerification: 'required' | 'preferred' | 'discouraged'
}

export type AuthenticationBeginResult = {
  challengeId: string
  options:     AuthenticationOptions
  qrPayload:   string   // base64url-encoded JSON of options (for QR URL)
}

export type DeviceKey = {
  id:           CredentialId
  publicKey:    string    // base64url-encoded COSE key (EC2 P-256)
  counter:      number    // replay protection
  deviceName:   string
  registeredAt: number
}

export type User = {
  id:         UserId
  username:   string
  phone?:     string    // E.164, unverified
  createdAt:  number
  roles:      string[]
  deviceKeys: DeviceKey[]
}

export type AuthSession = {
  token:     string    // 256-bit random, base64url
  userId:    UserId
  username:  string
  roles:     string[]
  expiresAt: number
}

export type AuthChallenge = {
  id:              string
  value:           string   // base64url challenge bytes
  type:            'registration' | 'authentication'
  username?:       string   // stored by beginRegistration (phone number)
  userId?:         UserId   // stored by beginAuthentication (unused currently)
  expiresAt:       number
  fulfilledToken?: string   // set by finishAuthentication; consumed by pollChallenge
}

export type AuthLoginEvent  = { userId: UserId; username: string; roles: string[] }
export type AuthLogoutEvent = { userId: UserId }

// ─── UserStore messages ───

export type UserStoreMsg =
  | { type: 'createUser';          username: string; phone?: string; replyTo: ActorRef<{ ok: User } | { error: string }> }
  | { type: 'getUser';             userId: UserId;       replyTo: ActorRef<User | null> }
  | { type: 'getUserByCredential'; credentialId: string; replyTo: ActorRef<User | null> }
  | { type: 'getUserByPhone';      phone: string;        replyTo: ActorRef<User | null> }
  | { type: 'addDeviceKey';        userId: UserId; key: DeviceKey; replyTo: ActorRef<{ ok: true } | { error: string }> }
  | { type: 'updateKeyCounter';    credentialId: string; counter: number }
  | { type: 'listUsers';           replyTo: ActorRef<User[]> }

// ─── Authenticator messages ───
// Internal messages (_regDone etc.) follow the same convention as the rest
// of the codebase (see http.ts _mediaSaved, chatbot.ts _toolResult).

export type AuthenticatorMsg =
  | { type: 'beginRegistration';    phone: string; replyTo: ActorRef<RegistrationBeginResult | { error: string }> }
  | { type: 'finishRegistration';   challengeId: string; credential: WebAuthnCredential; replyTo: ActorRef<{ token: string } | { error: string }> }
  | { type: 'beginAuthentication';  replyTo: ActorRef<AuthenticationBeginResult | { error: string }> }
  | { type: 'finishAuthentication'; challengeId: string; credential: WebAuthnCredential; replyTo: ActorRef<{ token: string } | { error: string }> }
  | { type: 'pollChallenge';        challengeId: string; replyTo: ActorRef<{ token: string } | { pending: true } | { error: string }> }
  | { type: 'pollRegistration';     challengeId: string; replyTo: ActorRef<{ token: string } | { pending: true } | { error: string }> }
  | { type: 'getAuthOptions';       challengeId: string; replyTo: ActorRef<AuthenticationOptions | null> }
  | { type: 'getRegOptions';        challengeId: string; replyTo: ActorRef<RegistrationOptions | null> }
  | { type: 'validateToken';        token: string;       replyTo: ActorRef<AuthSession | null> }
  | { type: 'revokeToken';          token: string }
  | { type: 'issueTicket';          token: string;       replyTo: ActorRef<{ ticket: string } | { error: string }> }
  | { type: 'validateTicket';       ticket: string;      replyTo: ActorRef<AuthSession | null> }
  | { type: '_gc' }
  // ─── pipeToSelf completions ───
  | { type: '_regDone';   userId: string; username: string; roles: string[]; challengeId: string; replyTo: ActorRef<{ token: string } | { error: string }> }
  | { type: '_regFailed'; error: string;  replyTo: ActorRef<{ token: string } | { error: string }> }
  | { type: '_authDone';  userId: string; username: string; roles: string[]; challengeId: string; credentialId: string; newCounter: number; replyTo: ActorRef<{ token: string } | { error: string }> }
  | { type: '_authFailed'; error: string; replyTo: ActorRef<{ token: string } | { error: string }> }

// ─── Topics ───

export const AuthenticatorTopic = createTopic<{ ref: ActorRef<AuthenticatorMsg> | null }>('auth.authenticator')
export const UserStoreTopic     = createTopic<{ ref: ActorRef<UserStoreMsg>     | null }>('auth.user-store')
export const AuthLoginTopic     = createTopic<AuthLoginEvent>('auth.login')
export const AuthLogoutTopic    = createTopic<AuthLogoutEvent>('auth.logout')
