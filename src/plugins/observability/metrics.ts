import { MetricsTopic } from '../../system/index.ts'
import type { ActorDef, MetricsEvent } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { OutboundAdminBroadcastTopic } from '../../types/events.ts'
import type { MetricsActorOptions } from './types.ts'

type MetricsMsg = { type: 'tick' }



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
      ctx.publish(OutboundAdminBroadcastTopic, {
        type: 'metrics',
        key: 'metrics',
        payload: JSON.stringify({ type: 'metrics', ...event }),
      })
      return { state }
    }
  }),
})
