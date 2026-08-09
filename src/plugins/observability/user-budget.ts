import type { ActorDef, ActorRef } from '../../system/index.ts'
import { onLifecycle, onMessage, persistencePluginAdapter } from '../../system/index.ts'
import type { UserBudgetRecord, UsageUpdateEvent } from '../../types/scr.ts'
import { UserBudgetTopic, UsageUpdateTopic } from '../../types/scr.ts'

export type UserBudgetActorMsg =
  | { type: 'update'; tokens: number; costUsd: number }
  | { type: 'setMaxBudget'; maxTokens?: number; maxCostUsd?: number }

export const UserBudgetActor = (userId: string): ActorDef<UserBudgetActorMsg, UserBudgetRecord> => ({
  initialState: () => ({
    userId,
    tokensSpent: 0,
    costSpentUsd: 0,
  }),

  persistence: persistencePluginAdapter<UserBudgetRecord>(`user-budget-${userId}`),

  lifecycle: onLifecycle({
    start: (state, ctx) => {
      ctx.publishRetained(UserBudgetTopic, userId, state)
      return { state }
    },
  }),

  handler: onMessage({
    update: (state, msg, ctx) => {
      state.tokensSpent += msg.tokens
      state.costSpentUsd += msg.costUsd
      ctx.publishRetained(UserBudgetTopic, userId, state)
      return { state }
    },
    setMaxBudget: (state, msg, ctx) => {
      state.maxTokens = msg.maxTokens
      state.maxCostUsd = msg.maxCostUsd
      ctx.publishRetained(UserBudgetTopic, userId, state)
      return { state }
    },
  }),
})

export type UserBudgetSupervisorMsg =
  | { type: '_usageUpdate'; event: UsageUpdateEvent }

export type UserBudgetSupervisorState = {
  children: Record<string, ActorRef<UserBudgetActorMsg>>
}

export const UserBudgetSupervisor = (): ActorDef<UserBudgetSupervisorMsg, UserBudgetSupervisorState> => ({
  initialState: () => ({
    children: {},
  }),

  lifecycle: onLifecycle({
    start: (state, ctx) => {
      ctx.subscribe(UsageUpdateTopic, (event) => ({
        type: '_usageUpdate',
        event,
      }))
      return { state }
    },
  }),

  handler: onMessage({
    _usageUpdate: (state, msg, ctx) => {
      const { userId, tokens, costUsd } = msg.event
      let childRef = state.children[userId]

      if (!childRef) {
        childRef = ctx.spawn(`user-budget-${userId}`, UserBudgetActor(userId))
        state.children[userId] = childRef
      }

      ctx.send(childRef, { type: 'update', tokens, costUsd })
      return { state }
    },
  }),
})
