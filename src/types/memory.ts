import { createTopic } from '../system/types.ts'

// ─── Topic: published (retained) after each context summary generation ───

export type UserContextEvent = { userId: string; summary: string }
export const UserContextTopic = createTopic<UserContextEvent>('memory.user.context')
