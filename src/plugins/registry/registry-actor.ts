import type { ActorDef } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { SCRRegistrationTopic, type SCRRegistrationEvent } from '../../types/scr.ts'
import type { RegistryMsg, RegistryState } from './types.ts'

export const SCRRegistry = (): ActorDef<RegistryMsg, RegistryState> => ({
  initialState: () => ({
    descriptors: new Map(),
  }),

  lifecycle: onLifecycle({
    start: (state, ctx) => {
      ctx.subscribe(SCRRegistrationTopic, (event: SCRRegistrationEvent) => {
        if (event.type === 'register') {
          return { type: '_register', descriptor: event.descriptor }
        } else {
          return { type: '_deregister', urn: event.urn }
        }
      })
      return { state }
    },
  }),

  handler: onMessage({
    _register: (state, msg) => {
      state.descriptors.set(msg.descriptor.urn, msg.descriptor)
      return { state }
    },
    _deregister: (state, msg) => {
      state.descriptors.delete(msg.urn)
      return { state }
    },
  }),
})
