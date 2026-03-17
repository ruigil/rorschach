import { MetricsTopic } from '../../system/types.ts'
import type { ActorDef, ActorSnapshot, MetricsEvent } from '../../system/types.ts'

type MetricsMsg = { type: 'tick' }

export type MetricsActorOptions = {
  intervalMs: number
}

export const createMetricsActor = (options: MetricsActorOptions): ActorDef<MetricsMsg, null> => ({
  lifecycle: (state, event, ctx) => {
    if (event.type === 'start') {
      ctx.timers.startPeriodicTimer('metrics-tick', { type: 'tick' }, options.intervalMs)
    }
    return { state }
  },

  handler: (state, _msg, ctx) => {
    const event: MetricsEvent = {
      timestamp: Date.now(),
      actors: ctx.actorSnapshots(),
    }
    ctx.publish(MetricsTopic, event)
    return { state }
  },
})
