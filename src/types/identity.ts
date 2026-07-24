import { createTopic, type ActorRef } from '../system/index.ts'

export type Identity = {
  userId:   string
  fullName: string
  roles:    string[]
  timezone?: string
}

// ─── Provider protocol ───
//
// Channel-medium discriminators, not backend-mechanism. Any provider
// implementation (WebAuthn, OAuth, SSO, magic-link, …) handles whichever
// variants make sense for its surface.

export type IdentityProviderMsg =
  | { type: 'resolveTicket'; ticket: string; replyTo: ActorRef<Identity | null> }
  | { type: 'resolveCookie'; cookie: string; replyTo: ActorRef<Identity | null> }
  | { type: 'resolvePhone';  phone:  string; replyTo: ActorRef<Identity | null> }

export const IdentityProviderTopic = createTopic<{ ref: ActorRef<IdentityProviderMsg> | null }>('identity.provider')
