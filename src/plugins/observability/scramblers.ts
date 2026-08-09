import { onLifecycle, onMessage } from '../../system/index.ts'
import { SCRRegistrationTopic } from '../../types/scr.ts'
import { HttpWsFrameTopic, OutboundAdminBroadcastTopic, OutboundUserMessageTopic } from '../../types/events.ts'
import type { ActorDef } from '../../system/index.ts'
import type { ScramblersMsg, ScramblersState } from './types.ts'
import { ResolutionCache } from '../../system/index.ts'

export const Scramblers = (): ActorDef<ScramblersMsg, ScramblersState> => ({
  initialState: { scramblers: {} },
  lifecycle: onLifecycle({
    start: (state, ctx) => {
      ctx.subscribe(SCRRegistrationTopic, (event) => ({ type: '_scrReg' as const, event }))
      ctx.subscribe(HttpWsFrameTopic, (event) => ({ type: '_wsFrame' as const, event }))
      
      // Seed initial scramblers from cache
      const initialScramblers: Record<string, any> = {}
      for (const desc of ResolutionCache.getAllDescriptors()) {
        initialScramblers[desc.urn] = desc
      }
      return { state: { scramblers: initialScramblers } }
    }
  }),
  handler: onMessage({
    _scrReg: (state, msg, ctx) => {
      const { event } = msg
      const scramblers = { ...state.scramblers }
      if (event.type === 'deregister') {
        delete scramblers[event.urn]
        ctx.publish(OutboundAdminBroadcastTopic, {
          type: 'scramblers.unregistered',
          key: event.urn,
          payload: JSON.stringify({ type: 'scramblers.unregistered', urn: event.urn })
        })
      } else if (event.type === 'register') {
        scramblers[event.descriptor.urn] = event.descriptor
        // We omit the `target` ActorRef when sending to UI to avoid JSON serialization errors
        const clientDescriptor = {
          urn: event.descriptor.urn,
          kind: event.descriptor.kind,
          description: event.descriptor.description,
          schema: event.descriptor.schema,
          tags: event.descriptor.tags,
          yieldsPending: event.descriptor.yieldsPending,
          meta: event.descriptor.meta
        }
        ctx.publish(OutboundAdminBroadcastTopic, {
          type: 'scramblers.registered',
          key: event.descriptor.urn,
          payload: JSON.stringify({ type: 'scramblers.registered', descriptor: clientDescriptor })
        })
      }
      return { state: { ...state, scramblers } }
    },
    _wsFrame: (state, msg, ctx) => {
      const { userId, frame } = msg.event
      if (frame.type === 'scramblers.list.request') {
        for (const desc of Object.values(state.scramblers)) {
          // Omit the `target` ActorRef when sending to UI to avoid JSON serialization errors
          const clientDescriptor = {
            urn: desc.urn,
            kind: desc.kind,
            description: desc.description,
            schema: desc.schema,
            tags: desc.tags,
            yieldsPending: desc.yieldsPending,
            meta: desc.meta
          }
          ctx.publish(OutboundUserMessageTopic, {
            userId,
            text: JSON.stringify({ type: 'scramblers.registered', descriptor: clientDescriptor })
          })
        }
      }
      return { state }
    }
  })
})
