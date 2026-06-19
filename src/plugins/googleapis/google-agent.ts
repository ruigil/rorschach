import type { ActorDef, ActorContext, ActorRef, ActorResult, Interceptor } from '../../system/index.ts'
import type { ToolReply } from '../../types/tools.ts'
import { onLifecycle } from '../../system/index.ts'
import { agentLoop, idleLoopState, type LoopState } from '../../system/index.ts'
import type { ToolCollection } from '../../types/tools.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import type { GoogleAgentMsg } from './types.ts'

// ─── Options ───

export type GoogleAgentOptions = {
  model:        string
  maxToolLoops: number
  tools:        ToolCollection
}

// ─── State ───

export type GoogleAgentState = {
  loop:    LoopState
  replyTo: ActorRef<ToolReply> | null
  llmRef:  ActorRef<LlmProviderMsg> | null
}

// ─── Helpers ───

const todayISO = (): string => new Date().toISOString().slice(0, 10)

const buildSystemPrompt = (): string =>
  `You are a Google Workspace agent. Today is ${todayISO()}.\n\n` +
  `You have access to the user's Gmail, Google Calendar, Google Drive, and YouTube.\n\n` +
  `Available tools:\n` +
  `- Gmail: gmail_list_messages, gmail_get_message, gmail_send_message, gmail_search\n` +
  `- Calendar: calendar_list_events, calendar_create_event, calendar_update_event, calendar_delete_event\n` +
  `- Drive: drive_list_files, drive_search_files, drive_get_file, drive_download_file, drive_upload_file\n` +
  `- YouTube: youtube_search_videos, youtube_video_details\n\n` +
  `IMPORTANT — YouTube:\n` +
  `When returning YouTube search results or video details, you MUST include the **Title** and a **Link** (https://www.youtube.com/watch?v=VIDEO_ID) for each video. Do not return just a description.\n\n` +
  `IMPORTANT — Drive downloads:\n` +
  `drive_download_file saves files to workspace/media/inbound/ and returns an absolute path.\n` +
  `Docs: exportFormat "text" (default) or "pdf". Sheets: "csv" (default) or "pdf". Slides: always pdf.\n` +
  `IMPORTANT — Drive uploads:\n` +
  `drive_upload_file accepts inline text content OR a filePath to a local file.\n` +
  `When the request contains an absolute path (starts with /), pass it as file Path — do NOT pass it as content or name.\n` +
  `When using filePath, the name parameter is optional (inferred from the filename).\n\n` +
  `IMPORTANT — calendar times:\n` +
  `Always pass datetimes as naive local time with NO UTC offset (e.g. "2025-05-06T14:00:00").\n` +
  `The system automatically applies the user's Google Calendar timezone. Never add +HH:MM or Z.\n\n` +
  `Use the appropriate tools to fulfill the user's request. Reply with a concise summary of what was done.\n\n` +
  `Your reply is not for the final user but a main service agent. Do not use fillers or engage in conversation. Be formal and factual.`

// ─── Actor ───

export const GoogleAgent = (options: GoogleAgentOptions): ActorDef<GoogleAgentMsg, GoogleAgentState> => {

  const handleInvoke = (state: GoogleAgentState, msg: Extract<GoogleAgentMsg, { type: 'invoke' }>, ctx: ActorContext<GoogleAgentMsg>): ActorResult<GoogleAgentMsg, GoogleAgentState> => {
    let request: string
    try {
      const args = JSON.parse(msg.arguments) as { request?: string }
      request = args.request ?? msg.arguments
    } catch {
      msg.replyTo.send({ type: 'toolError', error: 'Invalid arguments: expected { request: string }' })
      return { state }
    }
    if (!state.llmRef) {
      msg.replyTo.send({ type: 'toolError', error: 'Google agent not ready (no LLM provider).' })
      return { state }
    }
    return loop.startTurn(
      { ...state, replyTo: msg.replyTo },
      {
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user',   content: request },
        ],
        userId:   msg.userId,
      },
      ctx,
    )
  }

  const loop = agentLoop<GoogleAgentState, GoogleAgentMsg>({
    role:         'google',
    spanName:     'google-agent',
    logPrefix:    'google-agent',
    model:        options.model,
    maxToolLoops: options.maxToolLoops,
    llmRef:       (s) => s.llmRef,
    tools:        options.tools,

    onComplete: (state, finalText) => {
      state.replyTo?.send({ type: 'toolResult', result: { text: finalText || '(done)' } })
      return { state }
    },

    onError: (state, err) => {
      if (err.kind === 'llm') {
        state.replyTo?.send({ type: 'toolError', error: 'Google agent encountered an LLM error.' })
      } else {
        state.replyTo?.send({ type: 'toolError', error: 'Tool loop limit reached.' })
      }
      return { state }
    },
  })

  const hostInterceptor: Interceptor<GoogleAgentMsg, GoogleAgentState> = (state, msg, ctx, next) => {
    const m = msg as GoogleAgentMsg

    if (m.type === 'invoke') {
      if (state.loop.phase !== 'idle') return { state, stash: true }
      return handleInvoke(state, m as Extract<GoogleAgentMsg, { type: 'invoke' }>, ctx)
    }

    if (m.type === '_llmProvider') {
      return { state: { ...state, llmRef: m.ref } }
    }

    return next(state, msg)
  }

  return {
    initialState: () => ({ loop: idleLoopState(), replyTo: null, llmRef: null }),
    lifecycle: onLifecycle({
      start: (state, context) => {
        context.subscribe(LlmProviderTopic, (e) => ({ type: '_llmProvider' as const, ref: e.ref }))
        return { state }
      },
    }),

    handler:      loop.idle,
    interceptors: [hostInterceptor],

    stashCapacity: 50,
    supervision:   { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
