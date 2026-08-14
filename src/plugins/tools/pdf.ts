import type { ActorDef, ActorRef, SpanHandle } from '../../system/index.ts'
import { onMessage, onLifecycle, ask } from '../../system/index.ts'
import { defineTool } from '../../system/index.ts'
import { getDocumentProxy, extractText } from 'unpdf'
import { PersistenceProviderTopic } from '../../types/persistence.ts'
import type { PersistenceMsg, PResult, PObjGetPayload } from '../../types/persistence.ts'
import type { PdfState, PdfMsg } from './types.ts'

// ─── Tool schema ───

export const pdfTool = defineTool('tools_pdf_extract_text', 'Extract text content from a PDF file stored in persistence. Provide the object store key of the PDF.', {
  type: 'object',
  properties: { key: { type: 'string', description: 'Object store key of the PDF file' } },
  required: ['key'],
})

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
      const { input, replyTo } = message
      let key = ''
      if (typeof input === 'string') {
        try {
          key = (JSON.parse(input) as { key?: string }).key || input
        } catch {
          key = input
        }
      } else if (input && typeof input === 'object' && 'key' in input) {
        key = String((input as { key: unknown }).key ?? '')
      }

      if (!state.persistenceRef) {
        replyTo.send({ type: 'error', error: 'Persistence provider not ready.' })
        return { state }
      }

      if (!key) {
        replyTo.send({ type: 'error', error: 'Invalid arguments: key is required' })
        return { state }
      }

      const span = ctx.trace.span('pdf-extract', { key })

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
      replyTo.send({ type: 'result', output: { text: `[${pages} page(s)]\n\n${text}` } })
      return { state }
    },

    _err: (state, message, ctx) => {
      const { key, error, replyTo, span } = message
      ctx.log.error('pdf extraction failed', { key, error })
      span?.error(error)
      replyTo.send({ type: 'error', error })
      return { state }
    },
  }),

  supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
})

