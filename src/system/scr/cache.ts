import type { SCRDescriptor, UserBudgetRecord, SCRRegistrationEvent } from '../../types/scr.ts'
import { SCRRegistrationTopic, UserBudgetTopic } from '../../types/scr.ts'

// Private states enclosed inside the module scope (closure)
const descriptors = new Map<string, SCRDescriptor>()
const budgets = new Map<string, UserBudgetRecord>()
const activeSubscriptions = new Set<() => void>()

export const ResolutionCache = {
  initialize: (system: {
    subscribe: <T>(topic: any, callback: (event: T) => void) => () => void
  }) => {
    const unsubReg = system.subscribe(SCRRegistrationTopic, (event: SCRRegistrationEvent) => {
      if (event.type === 'register') {
        descriptors.set(event.descriptor.urn, event.descriptor)
      } else if (event.type === 'deregister') {
        descriptors.delete(event.urn)
      }
    })

    const unsubBudget = system.subscribe(UserBudgetTopic, (record: UserBudgetRecord) => {
      budgets.set(record.userId, record)
    })

    activeSubscriptions.add(unsubReg)
    activeSubscriptions.add(unsubBudget)
  },

  getDescriptor: (urn: string): SCRDescriptor | undefined =>
    descriptors.get(urn),

  getBudget: (userId: string): UserBudgetRecord | undefined =>
    budgets.get(userId),

  clear: () => {
    descriptors.clear()
    budgets.clear()
    for (const unsub of activeSubscriptions) {
      try {
        unsub()
      } catch {
        // Ignore
      }
    }
    activeSubscriptions.clear()
  },

  getAllDescriptors: (): SCRDescriptor[] =>
    Array.from(descriptors.values())
}
