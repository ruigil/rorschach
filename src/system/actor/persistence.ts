import { ask } from './ask.ts'
import type { ActorServices, PersistenceAdapter, ActorRef } from './types.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult } from '../../types/persistence.ts'

export const resolvePersistence = (services: ActorServices): Promise<ActorRef<PersistenceMsg>> => {
  const current = services.eventStream.getRetainedValue(PersistenceProviderTopic, 'provider')
  if (current?.ref) {
    return Promise.resolve(current.ref)
  }

  return new Promise((resolve) => {
    const tempSubId = `temp-dl-resolver-${crypto.randomUUID()}`
    services.eventStream.subscribe(tempSubId, PersistenceProviderTopic, (event) => {
      if (event?.ref) {
        services.eventStream.unsubscribe(tempSubId, PersistenceProviderTopic)
        resolve(event.ref)
      }
    })
  })
}

// IMPORTANT: The following adapter writes the **entire** actor state as one
// JSON blob per kv.get/kv.put pair. Actors whose state exceeds ~100 KB should
// consider namespace splitting (e.g. one key per entity) instead of a
// monolithic snapshot. For giant payloads, see Document Store alternatives.

export const persistencePluginAdapter = <S>(
  key: string,
): PersistenceAdapter<S> => ({
  load: async (services) => {
    const persist = await resolvePersistence(services)
    const res = await ask<PersistenceMsg, PResult<unknown>>(persist, (replyTo) => ({ type: 'kv.get' as const, key, replyTo }))
    if (!res.ok) return undefined
    return res.data as S
  },
  save: async (state, services) => {
    const persist = await resolvePersistence(services)
    // send() is the fire-and-forget method on ActorRef — no confirmation needed.
    // For the KV-backed persistence adapter we use ask to get error feedback.
    const res = await ask<PersistenceMsg, PResult>(persist, (replyTo) => ({ type: 'kv.put' as const, key, value: state, replyTo }))
    if (!res.ok) {
      throw new Error(`Persistence save failed: ${res.error}`)
    }
  },
})
