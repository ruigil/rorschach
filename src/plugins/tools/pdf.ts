import type { ActorDef, ActorRef, SpanHandle } from '../../system/index.ts'
import { onMessage, onLifecycle } from '../../system/index.ts'
import { defineTool } from '../../system/index.ts'
import type { ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import { getDocumentProxy, extractText } from 'unpdf'
import { PersistenceProviderTopic } from '../../types/persistence.ts'
import type { PersistenceMsg, PResult, PObjGetPayload } from '../../types/persistence.ts'
import { ask } from '../../system/actor/ask.ts'

// ─── Tool schema ───

export const pdfTool = defineTool('extract_pdf_text', 'Extract text content from a PDF file stored in persistence. Provide the object store key of the PDF.', {
  type: 'object',
  properties: { key: { type: 'string', description: 'Object store key of the PDF file' } },
  required: ['key'],
})

// ─── Internal message protocol ───

export type PdfState = {
  persistenceRef: ActorRef<PersistenceMsg> | null
}

export type PdfMsg =
  | ToolInvokeMsg
  | { type: '_persistenceRef'; ref: ActorRef<PersistenceMsg> | null }
  | { type: '_done'; key: string; text: string; pages: number; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_err'; key: string; error: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }

// ─── PDF extraction ───

const extractPdfTextFromPersistence = async (
  key: string,
  persistenceRef: ActorRef<PersistenceMsg>
): Promise<{ text: string; pages: number }> => {
  const res = await ask<PersistenceMsg, PResult<PObjGetPayload>>(persistenceRef, (replyTo) => ({
    type: 'obj.get',
    bucket: 'media',
    key,
    replyTo,
  }))
  if (!res.ok) {
    throw new Error(`Failed to load PDF from persistence: ${res.error}`)
  }
  if (!res.data) {
    throw new Error('Failed to load PDF from persistence: No data')
  }

  const pdf = await getDocumentProxy(new Uint8Array(res.data.data))
  const { text } = await extractText(pdf, { mergePages: true })
  return { text: Array.isArray(text) ? text.join('\n') : text, pages: pdf.numPages }
}

// ─── Actor definition ───

export const PDF = (): ActorDef<PdfMsg, PdfState> => ({
  initialState: () => ({ persistenceRef: null }),
  lifecycle: onLifecycle({
    start: (state, ctx) => {
      ctx.subscribe(PersistenceProviderTopic, (event) => ({ type: '_persistenceRef' as const, ref: event.ref }))
      return { state }
    },
  }),
  handler: onMessage<PdfMsg, PdfState>({
    _persistenceRef: (state, msg) => {
      return { state: { ...state, persistenceRef: msg.ref } }
    },

    invoke: (state, message, ctx) => {
      const { arguments: args, replyTo } = message
      let key = ''
      try { key = (JSON.parse(args) as { key: string }).key } catch { key = args }

      if (!state.persistenceRef) {
        replyTo.send({ type: 'toolError', error: 'Persistence provider not ready.' })
        return { state }
      }

      const parent = ctx.trace.fromHeaders()
      const span: SpanHandle | null = parent
        ? ctx.trace.child(parent.traceId, parent.spanId, 'pdf-extract', { key })
        : null

      ctx.pipeToSelf(
        extractPdfTextFromPersistence(key, state.persistenceRef),
        ({ text, pages }) => ({ type: '_done' as const, key, text, pages, replyTo, span }),
        (error) => ({ type: '_err' as const, key, error: String(error), replyTo, span }),
      )
      return { state }
    },

    _done: (state, message) => {
      const { text, pages, replyTo, span } = message
      span?.done({ pages })
      replyTo.send({ type: 'toolResult', result: { text: `[${pages} page(s)]\n\n${text}` } })
      return { state }
    },

    _err: (state, message, ctx) => {
      const { key, error, replyTo, span } = message
      ctx.log.error('pdf extraction failed', { key, error })
      span?.error(error)
      replyTo.send({ type: 'toolError', error })
      return { state }
    },
  }),

  supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
})

