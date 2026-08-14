import type { ActorDef } from '../../system/index.ts'
import { onMessage } from '../../system/index.ts'
import type { SCRInvokeMsg, SCRDescriptor } from '../../types/scr.ts'
import { ResolutionCache } from '../../system/scr/cache.ts'

export const RegistryMetaToolsActor = (): ActorDef<SCRInvokeMsg, null> => ({
  initialState: null,
  handler: onMessage({
    invoke: (state, msg) => {
      const urn = msg.urn
      const input = msg.input
      const replyTo = msg.replyTo

      const sendReply = (output: any) => {
        replyTo.send({
          type: 'result',
          output
        })
      }

      const sendError = (error: string) => {
        replyTo.send({
          type: 'error',
          error
        })
      }

      if (urn === 'scr:leaf:registry.search') {
        const { query } = (input || {}) as { query?: string }
        const all = ResolutionCache.getAllDescriptors()
        let filtered = all
        if (query) {
          const q = query.toLowerCase()
          filtered = all.filter(
            (d) =>
              d.urn.toLowerCase().includes(q) ||
              d.kind.toLowerCase().includes(q) ||
              d.description.toLowerCase().includes(q) ||
              d.tags?.some((t) => t.toLowerCase().includes(q))
          )
        }
        const output = filtered.map(({ target: _, ...rest }) => rest)
        sendReply(output)
      } else if (urn === 'scr:leaf:registry.get') {
        const { urn: targetUrn } = (input || {}) as { urn: string }
        const descriptor = ResolutionCache.getDescriptor(targetUrn)
        if (!descriptor) {
          sendError(`Capability not found: ${targetUrn}`)
        } else {
          const { target: _, ...rest } = descriptor
          sendReply(rest)
        }
      } else {
        sendError(`Unsupported meta-tool URN: ${urn}`)
      }
      return { state }
    },
  }),
})

export const searchMetaToolDescriptor = (target: any): SCRDescriptor => ({
  urn: 'scr:leaf:registry.search',
  kind: 'leaf',
  description: 'Search for registered capabilities by query matching URN, kind, tags, and description.',
  schema: {
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' }
      }
    },
    outputSchema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          urn: { type: 'string' },
          kind: { type: 'string' },
          description: { type: 'string' },
          schema: { type: 'object' },
          tags: { type: 'array', items: { type: 'string' } },
          yieldsPending: { type: 'boolean' }
        }
      }
    }
  },
  tags: ['registry', 'discovery'],
  target,
})

export const getMetaToolDescriptor = (target: any): SCRDescriptor => ({
  urn: 'scr:leaf:registry.get',
  kind: 'leaf',
  description: 'Retrieve details of a registered capability by its URN.',
  schema: {
    inputSchema: {
      type: 'object',
      properties: {
        urn: { type: 'string', description: 'Capability URN' }
      },
      required: ['urn']
    },
    outputSchema: {
      type: 'object',
      properties: {
        urn: { type: 'string' },
        kind: { type: 'string' },
        description: { type: 'string' },
        schema: { type: 'object' },
        tags: { type: 'array', items: { type: 'string' } },
        yieldsPending: { type: 'boolean' }
      }
    }
  },
  tags: ['registry', 'discovery'],
  target,
})
