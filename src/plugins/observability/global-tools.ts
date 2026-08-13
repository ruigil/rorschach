import { onLifecycle, onMessage } from '../../system/index.ts'
import { SCRRegistrationTopic } from '../../types/scr.ts'
import { HttpWsFrameTopic, OutboundAdminBroadcastTopic, OutboundUserMessageTopic } from '../../types/events.ts'
import type { ActorDef } from '../../system/index.ts'
import type { GlobalToolsMsg, GlobalToolsState } from './types.ts'

export const GlobalTools = (): ActorDef<any, any> => ({
  initialState: { tools: {} },
  lifecycle: onLifecycle({
    start: (state, ctx) => {
      ctx.subscribe(SCRRegistrationTopic, (event) => ({ type: '_scrReg' as const, event }))
      ctx.subscribe(HttpWsFrameTopic, (event) => ({ type: '_wsFrame' as const, event }))
      return { state }
    }
  }),
  handler: onMessage({
    _scrReg: (state, msg, ctx) => {
      const { event } = msg
      const tools = { ...state.tools }
      if (event.type === 'register') {
        const desc = event.descriptor
        if (desc.kind === 'leaf') {
          const name = desc.meta?.schema?.function?.name || desc.urn.split('.').pop() || ''
          const schema = desc.meta?.schema || {
            type: 'function',
            function: {
              name,
              description: desc.description,
              parameters: desc.schema.inputSchema || {},
            }
          }
          tools[name] = { name, schema }
          ctx.publish(OutboundAdminBroadcastTopic, {
            type: 'tools.registered',
            key: name,
            payload: JSON.stringify({ type: 'tools.registered', name, schema })
          })
        }
      } else {
        if (event.urn.startsWith('scr:leaf:')) {
          const name = event.urn.split('.').pop() || ''
          delete tools[name]
          ctx.publish(OutboundAdminBroadcastTopic, {
            type: 'tools.unregistered',
            key: name,
            payload: JSON.stringify({ type: 'tools.unregistered', name })
          })
        }
      }
      return { state: { ...state, tools } }
    },
    _wsFrame: (state, msg, ctx) => {
      const { userId, frame } = msg.event
      if (frame.type === 'tools.list.request') {
        for (const [name, tool] of Object.entries(state.tools) as any) {
          ctx.publish(OutboundUserMessageTopic, {
            userId,
            text: JSON.stringify({ type: 'tools.registered', name, schema: tool.schema })
          })
        }
      }
      return { state }
    }
  })
})
