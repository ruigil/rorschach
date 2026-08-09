import type { ActorDef } from '../index.ts'
import { onLifecycle, onMessage } from '../index.ts'
import { PersistenceProviderTopic } from '../../types/persistence.ts'
import type { PersistenceMsg, PList, PResult } from '../../types/persistence.ts'
import { ask } from '../actor/ask.ts'

type GCMessage =
  | { type: 'sweep' }
  | { type: '_persistenceRef'; ref: any }
  | { type: '_sweepDone' }

type GCState = {
  persistenceRef: any
  bootTime: number
}

const performSweep = async (
  persistenceRef: any,
  bootTime: number,
  ctx: any
): Promise<void> => {
  const listRes = await ask<PersistenceMsg, PList>(persistenceRef, (replyTo) => ({
    type: 'kv.list',
    prefix: 'scr.run.',
    replyTo,
  }))

  if (!listRes.ok || !listRes.keys) return

  const activeActorNames = new Set<string>(ctx.actorSnapshots().map((a: any) => a.name))

  for (const key of listRes.keys) {
    const runId = key.replace('scr.run.', '')
    const isActorActive = Array.from(activeActorNames).some((name) => name.includes(runId))
    if (isActorActive) {
      continue
    }

    const getRes = await ask<PersistenceMsg, PResult<unknown>>(persistenceRef, (replyTo) => ({
      type: 'kv.get',
      key,
      replyTo,
    }))

    if (getRes.ok && getRes.data) {
      const data = getRes.data as any
      const lastUpdated = data.timestamp || data.updatedAt || 0

      const isBeforeBoot = lastUpdated < bootTime
      const isVeryOld = Date.now() - lastUpdated > 24 * 3600 * 1000

      if (isBeforeBoot || isVeryOld || lastUpdated === 0) {
        ctx.log.info(`GC: Deleting orphaned runner key ${key}`, { lastUpdated })
        await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
          type: 'kv.delete',
          key,
          replyTo,
        }))
      }
    }
  }
}

export const SCRGCSweeper = (): ActorDef<GCMessage, GCState> => ({
  initialState: () => ({
    persistenceRef: null,
    bootTime: Date.now(),
  }),

  lifecycle: onLifecycle({
    start: (state, ctx) => {
      ctx.subscribe(PersistenceProviderTopic, (event) => ({
        type: '_persistenceRef',
        ref: event.ref,
      }))

      ctx.timers.startPeriodicTimer('hourly-gc', { type: 'sweep' }, 3600_000)
      return { state }
    },
  }),

  handler: onMessage({
    _persistenceRef: (state, msg, ctx) => {
      state.persistenceRef = msg.ref
      if (msg.ref) {
        ctx.timers.startSingleTimer('initial-gc', { type: 'sweep' }, 5000)
      }
      return { state }
    },

    sweep: (state, msg, ctx) => {
      if (!state.persistenceRef) return { state }

      ctx.pipeToSelf(
        performSweep(state.persistenceRef, state.bootTime, ctx),
        () => ({ type: '_sweepDone' as const }),
        (err) => {
          ctx.log.error('GC sweep failed', err)
          return { type: '_sweepDone' as const }
        }
      )
      return { state }
    },

    _sweepDone: (state) => {
      return { state }
    },
  }),
})
