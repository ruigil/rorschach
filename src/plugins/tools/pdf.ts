import type { ActorDef, ActorRef, SpanHandle } from '../../system/types.ts'
import { onMessage } from '../../system/match.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from '../../types/tools.ts'
import { getDocumentProxy, extractText } from 'unpdf'

// ─── Tool schema ───

export const PDF_TOOL_NAME = 'extract_pdf_text'

export const PDF_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: PDF_TOOL_NAME,
    description: 'Extract text content from a PDF file. Provide the absolute path to the PDF file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path to the PDF file' } },
      required: ['path'],
    },
  },
}

// ─── Internal message protocol ───

export type PdfMsg =
  | ToolInvokeMsg
  | { type: '_done'; path: string; text: string; pages: number; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_err'; path: string; error: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }

// ─── PDF extraction ───

const extractPdfText = async (path: string): Promise<{ text: string; pages: number }> => {
  const file = Bun.file(path)
  const buffer = await file.arrayBuffer()
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { text } = await extractText(pdf, { mergePages: true })
  return { text: Array.isArray(text) ? text.join('\n') : text, pages: pdf.numPages }
}

// ─── Actor definition ───

export const createPdfActor = (): ActorDef<PdfMsg, null> => ({
  handler: onMessage<PdfMsg, null>({
    invoke: (state, message, ctx) => {
      const { arguments: args, replyTo } = message
      let path = ''
      try { path = (JSON.parse(args) as { path: string }).path } catch { path = args }

      const parent = ctx.trace.fromHeaders()
      const span: SpanHandle | null = parent
        ? ctx.trace.child(parent.traceId, parent.spanId, 'pdf-extract', { path })
        : null

      ctx.pipeToSelf(
        extractPdfText(path),
        ({ text, pages }) => ({ type: '_done' as const, path, text, pages, replyTo, span }),
        (error) => ({ type: '_err' as const, path, error: String(error), replyTo, span }),
      )
      return { state }
    },

    _done: (state, message) => {
      const { text, pages, replyTo, span } = message
      span?.done({ pages })
      replyTo.send({ type: 'toolResult', result: `[${pages} page(s)]\n\n${text}` })
      return { state }
    },

    _err: (state, message, ctx) => {
      const { path, error, replyTo, span } = message
      ctx.log.error('pdf extraction failed', { path, error })
      span?.error(error)
      replyTo.send({ type: 'toolError', error })
      return { state }
    },
  }),

  supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
})
