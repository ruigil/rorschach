import { MetricsTopic } from '../../system/index.ts'
import type { ActorDef, MetricsEvent } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'

type MetricsMsg = { type: 'tick' }

export type MetricsActorOptions = {
  intervalMs: number
}

export const Metrics = (options: MetricsActorOptions): ActorDef<MetricsMsg, null> => ({
  initialState: null,
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
        topics: ctx.topicSnapshots(),
      }
      ctx.publish(MetricsTopic, event)
      return { state }
    }
  }),
})
