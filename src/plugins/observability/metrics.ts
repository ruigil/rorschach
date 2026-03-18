import { MetricsTopic } from '../../system/types.ts'
import type { ActorDef, MetricsEvent } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'

type MetricsMsg = { type: 'tick' }

export type MetricsActorOptions = {
  intervalMs: number
}

export const createMetricsActor = (options: MetricsActorOptions): ActorDef<MetricsMsg, null> => ({
  lifecycle: onLifecycle({
    start: (state, ctx) => {
      ctx.timers.startPeriodicTimer('metrics-tick', { type: 'tick' }, options.intervalMs)
      return { state }
    },
  }),

  handler: onMessage({
    tick: (state, _msg, ctx) => {
      const event: MetricsEvent = {
        timestamp: Date.now(),
        actors: ctx.actorSnapshots(),
      }
      ctx.publish(MetricsTopic, event)
      return { state }
    }
  }),
})
