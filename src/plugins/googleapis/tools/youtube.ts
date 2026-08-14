import { google } from 'googleapis'
import type { ActorDef, ActorRef } from '../../../system/index.ts'
import { onMessage } from '../../../system/index.ts'
import { ask } from '../../../system/index.ts'
import { defineTool } from '../../../system/index.ts'
import type { SCRInvokeMsg, SCRReply } from '../../../types/scr.ts'
import type { GoogleToken, TokenStoreMsg } from '../types.ts'

// ─── Tool names & schemas ───

export const youtubeSearchVideosTool = defineTool('googleapis_youtube_video_search', 'Search for YouTube videos by keyword or query.', {
  type: 'object',
  properties: {
    query:      { type: 'string', description: 'The search term or query.' },
    maxResults: { type: 'number', description: 'Maximum number of results to return (default 5, max 50).' },
  },
  required: ['query'],
})

export const youtubeVideoDetailsTool = defineTool('googleapis_youtube_video_details', 'Get details and statistics for a specific YouTube video.', {
  type: 'object',
  properties: {
    videoId: { type: 'string', description: 'The ID of the YouTube video.' },
  },
  required: ['videoId'],
})

// ─── Internal message type ───

type YoutubeMsg =
  | SCRInvokeMsg
  | { type: '_done';  replyTo: ActorRef<SCRReply>; result: string }
  | { type: '_error'; replyTo: ActorRef<SCRReply>; error: string }

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
        const executeYoutubeTool = async () => {
          const token = await ask<TokenStoreMsg, GoogleToken | null>(tokenStoreRef, r => ({ type: 'getToken' as const, replyTo: r }), undefined, ctx.request)
          if (!token) throw new Error('Not authenticated. Connect your Google account via Config > googleapis.')

          const auth = new google.auth.OAuth2(clientId, clientSecret)
          auth.setCredentials(token)
          if (token.expiry_date - Date.now() < 5 * 60 * 1000) {
            const { credentials } = await auth.refreshAccessToken()
            ctx.send(tokenStoreRef, { type: 'setToken' as const, token: credentials as GoogleToken })
            auth.setCredentials(credentials)
          }

          const youtube = google.youtube({ version: 'v3', auth })
          const args    = (typeof msg.input === 'string' ? JSON.parse(msg.input) : (msg.input ?? {})) as Record<string, any>

          const isSearch = msg.urn.endsWith('video_search') || msg.urn.endsWith('youtubeSearchVideos') || msg.urn.endsWith(youtubeSearchVideosTool.name)
          const isDetails = msg.urn.endsWith('video_details') || msg.urn.endsWith('youtubeVideoDetails') || msg.urn.endsWith(youtubeVideoDetailsTool.name)

          if (isSearch) {
            const res = await youtube.search.list({
              q: args.query,
              part: ['snippet'],
              type: ['video'],
              maxResults: args.maxResults ?? 5,
            })
            return JSON.stringify(res.data.items)
          }

          if (isDetails) {
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

          throw new Error(`Unknown YouTube tool: ${msg.urn}`)
        }

        ctx.pipeToSelf(
          executeYoutubeTool(),
          (result): YoutubeMsg => ({ type: '_done', replyTo: msg.replyTo, result }),
          (err):    YoutubeMsg => ({ type: '_error', replyTo: msg.replyTo, error: String(err) }),
        )
        return { state }
      },

      _done:  (state, msg) => { msg.replyTo.send({ type: 'result', output: { text: msg.result } }); return { state } },
      _error: (state, msg) => { msg.replyTo.send({ type: 'error',  error:  msg.error  }); return { state } },
    }),
  })
}
