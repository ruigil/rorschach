import { google } from 'googleapis'
import type { ActorDef, ActorRef } from '../../../system/types.ts'
import { onMessage } from '../../../system/match.ts'
import { ask } from '../../../system/ask.ts'
import { defineTool } from '../../../types/tools.ts'
import type { ToolInvokeMsg, ToolReply } from '../../../types/tools.ts'
import type { GoogleToken, TokenStoreMsg } from '../types.ts'

// ─── Tool names & schemas ───

export const youtubeSearchVideosTool = defineTool('youtube_search_videos', 'Search for YouTube videos by keyword or query.', {
  type: 'object',
  properties: {
    query:      { type: 'string', description: 'The search term or query.' },
    maxResults: { type: 'number', description: 'Maximum number of results to return (default 5, max 50).' },
  },
  required: ['query'],
})

export const youtubeVideoDetailsTool = defineTool('youtube_video_details', 'Get details and statistics for a specific YouTube video.', {
  type: 'object',
  properties: {
    videoId: { type: 'string', description: 'The ID of the YouTube video.' },
  },
  required: ['videoId'],
})

// ─── Internal message type ───

type YoutubeMsg =
  | ToolInvokeMsg
  | { type: '_done';  replyTo: ActorRef<ToolReply>; result: string }
  | { type: '_error'; replyTo: ActorRef<ToolReply>; error: string }

// ─── Actor ───

export const Youtube = (
  tokenStoreRef: ActorRef<TokenStoreMsg>,
  clientId:      string,
  clientSecret:  string,
): ActorDef<YoutubeMsg, null> => {
  return ({
    initialState: null,
    handler: onMessage<YoutubeMsg, null>({
      invoke: (state, msg, ctx) => {
        ctx.pipeToSelf(
          (async () => {
            const token = await ask<TokenStoreMsg, GoogleToken | null>(tokenStoreRef, r => ({ type: 'getToken' as const, userId: msg.userId, replyTo: r }))
            if (!token) throw new Error('Not authenticated. Connect your Google account via Config > googleapis.')

            const auth = new google.auth.OAuth2(clientId, clientSecret)
            auth.setCredentials(token)
            if (token.expiry_date - Date.now() < 5 * 60 * 1000) {
              const { credentials } = await auth.refreshAccessToken()
              tokenStoreRef.send({ type: 'setToken', userId: msg.userId, token: credentials as GoogleToken })
              auth.setCredentials(credentials)
            }

            const youtube = google.youtube({ version: 'v3', auth })
            const args    = JSON.parse(msg.arguments) as Record<string, any>

            if (msg.toolName === youtubeSearchVideosTool.name) {
              const res = await youtube.search.list({
                q: args.query,
                part: ['snippet'],
                type: ['video'],
                maxResults: args.maxResults ?? 5,
              })
              return JSON.stringify(res.data.items)
            }

            if (msg.toolName === youtubeVideoDetailsTool.name) {
              const res = await youtube.videos.list({
                id: [args.videoId],
                part: ['snippet', 'statistics', 'contentDetails'],
              })
              return JSON.stringify(res.data.items)
            }

            if (msg.toolName === youtubeVideoDetailsTool.name) {
              const res = await youtube.videos.list({
                id:   [args.videoId],
                part: ['snippet', 'statistics'],
              })
              const item = res.data.items?.[0]
              if (!item) return `No video found with ID: ${args.videoId}`

              return JSON.stringify({
                videoId:      item.id,
                title:        item.snippet?.title,
                description:  item.snippet?.description,
                viewCount:    item.statistics?.viewCount,
                likeCount:    item.statistics?.likeCount,
                commentCount: item.statistics?.commentCount,
                channelTitle: item.snippet?.channelTitle,
                publishedAt:  item.snippet?.publishedAt,
              })
            }

            throw new Error(`Unknown YouTube tool: ${msg.toolName}`)
          })(),
          (result): YoutubeMsg => ({ type: '_done', replyTo: msg.replyTo, result }),
          (err):    YoutubeMsg => ({ type: '_error', replyTo: msg.replyTo, error: String(err) }),
        )
        return { state }
      },

      _done:  (state, msg) => { msg.replyTo.send({ type: 'toolResult', result: { text: msg.result } }); return { state } },
      _error: (state, msg) => { msg.replyTo.send({ type: 'toolError',  error:  msg.error  }); return { state } },
    }),
  })
}
