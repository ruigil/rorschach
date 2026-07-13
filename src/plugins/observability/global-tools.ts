import { onLifecycle, onMessage } from '../../system/index.ts'
import { ToolRegistrationTopic } from '../../types/tools.ts'
import { HttpWsFrameTopic, OutboundAdminBroadcastTopic, OutboundUserMessageTopic } from '../../types/events.ts'
import type { ActorDef } from '../../system/index.ts'
import type { GlobalToolsMsg, GlobalToolsState } from './types.ts'



export const GlobalTools = (): ActorDef<GlobalToolsMsg, GlobalToolsState> => ({
  initialState: { tools: {} },
  lifecycle: onLifecycle({
    start: (state, ctx) => {
      ctx.subscribe(ToolRegistrationTopic, (event) => ({ type: '_toolReg' as const, event }))
      ctx.subscribe(HttpWsFrameTopic, (event) => ({ type: '_wsFrame' as const, event }))
      return { state }
    }
  }),
  handler: onMessage({
    _toolReg: (state, msg, ctx) => {
      const { event } = msg
      const tools = { ...state.tools }
      if (event.ref === null) {
        delete tools[event.name]
        ctx.publish(OutboundAdminBroadcastTopic, {
          type: 'tool_unregistered',
          key: event.name,
          payload: JSON.stringify({ type: 'tool_unregistered', name: event.name })
        })
      } else {
        tools[event.name] = event
        ctx.publish(OutboundAdminBroadcastTopic, {
          type: 'tool_registered',
          key: event.name,
          payload: JSON.stringify({ type: 'tool_registered', name: event.name, schema: event.schema })
        })
      }
      return { state: { ...state, tools } }
    },
    _wsFrame: (state, msg, ctx) => {
      const { userId, frame } = msg.event
      if (frame.type === 'observe.tools.request') {
        for (const [name, event] of Object.entries(state.tools)) {
          ctx.publish(OutboundUserMessageTopic, {
            userId,
            text: JSON.stringify({ type: 'tool_registered', name, schema: event.schema })
          })
        }
      }
      return { state }
    }
  })
})
