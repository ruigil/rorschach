import type { ActorDef, ActorRef, MessageHandler, SpanHandle } from '../../system/index.ts'
import { defineTool, onMessage, parseToolArgs, onLifecycle, ask } from '../../system/index.ts'
import type { ToolReply } from '../../types/tools.ts'
import type { DocumentationState, DocumentationMsg, DocPageMeta, DocsManifest, TocNode } from './types.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult } from '../../types/persistence.ts'

export const writeDocPageTool = defineTool('write_doc_page', 'Write one generated documentation page. Content should be semantic HTML for the page body; the tool wraps it in the app documentation shell.', {
  type: 'object',
  required: ['title', 'filename', 'summary', 'bodyHtml', 'sourcePaths'],
  properties: {
    title: { type: 'string', description: 'Page title.' },
    filename: { type: 'string', description: 'HTML filename, for example architecture.html.' },
    summary: { type: 'string', description: 'Short one sentence page summary.' },
    bodyHtml: { type: 'string', description: 'HTML body content. Use headings, paragraphs, lists, tables, and pre/code blocks.' },
    sourcePaths: { type: 'array', items: { type: 'string' }, description: 'Project paths used as sources for this page.' },
  },
})

export const deleteDocTool = defineTool('delete_doc', 'Delete a documentation page by its filename, updating the manifest and table of contents automatically.', {
  type: 'object',
  required: ['filename'],
  properties: {
    filename: { type: 'string', description: 'The filename of the documentation page to delete, e.g. architecture.html.' },
  },
})

export const writeTocTool = defineTool('write_toc', 'Write the hierarchical table of contents for the documentation, grouping files into categories.', {
  type: 'object',
  required: ['toc'],
  properties: {
    toc: {
      type: 'array',
      description: 'The hierarchical array of TOC nodes representing folders or links to pages.',
      items: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', description: 'The display title of this TOC node.' },
          filename: { type: 'string', description: 'The target HTML filename if this represents a page. Omit if it is a folder/category.' },
          children: { type: 'array', description: 'Sub-nodes under this category.' }
        }
      }
    }
  }
})

type PageArgs = {
  title: string
  filename: string
  summary: string
  bodyHtml: string
  sourcePaths: string[]
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const safeFilename = (filename: string): string => {
  const clean = filename.trim().replace(/\\/g, '/').split('/').pop() ?? ''
  const html = clean.endsWith('.html') ? clean : `${clean || 'page'}.html`
  return html.replace(/[^a-zA-Z0-9._-]/g, '-')
}

const isDocPageMeta = (value: unknown): value is DocPageMeta => {
  if (!value || typeof value !== 'object') return false
  const page = value as Record<string, unknown>
  return (
    typeof page.title === 'string' &&
    typeof page.filename === 'string' &&
    typeof page.summary === 'string' &&
    typeof page.createdAt === 'string' &&
    Array.isArray(page.sourcePaths) &&
    page.sourcePaths.every(path => typeof path === 'string')
  )
}

const readManifest = async (persistenceRef: ActorRef<any>): Promise<DocsManifest | null> => {
  let data = ''
  const res = await ask<PersistenceMsg, PResult<string>>(persistenceRef, (replyTo) => ({
    type: 'doc.get',
    collection: 'documentation',
    docId: 'manifest.json',
    replyTo,
  }))
  if (res.ok && res.data) data = res.data
  if (!data) return null
  try {
    const parsed = JSON.parse(data) as Partial<DocsManifest>
    if (typeof parsed.generatedAt !== 'string' || typeof parsed.query !== 'string' || !Array.isArray(parsed.pages)) return null
    return {
      generatedAt: parsed.generatedAt,
      query: parsed.query,
      pages: parsed.pages.filter(isDocPageMeta),
    }
  } catch {
    return null
  }
}

export const pageShell = (
  title: string,
  bodyHtml: string,
): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/style.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/base16/ocean.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
  <script>
    const copyCode = (btn) => {
      const codeBlock = btn.closest('.code-block');
      if (!codeBlock) return;
      const codeEl = codeBlock.querySelector('code');
      if (!codeEl) return;
      const code = codeEl.textContent || '';
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = 'copied';
        setTimeout(() => { btn.textContent = 'copy'; }, 1800);
      });
    }

    document.addEventListener('DOMContentLoaded', () => {
      // 1. Transform mermaid code blocks
      const mermaidBlocks = document.querySelectorAll('pre code.language-mermaid');
      if (mermaidBlocks.length > 0) {
        mermaidBlocks.forEach((block) => {
          const pre = block.parentElement;
          if (!pre) return;
          const container = document.createElement('div');
          container.className = 'mermaid';
          container.textContent = block.textContent;
          pre.replaceWith(container);
        });

        if (typeof mermaid !== 'undefined') {
          mermaid.initialize({
            startOnLoad: true,
            theme: 'dark',
            themeVariables: {
              background: '#060e14',
              primaryColor: '#0ea5e9',
              primaryTextColor: '#f8fafc',
              lineColor: '#334155',
              fontFamily: 'Inter, system-ui, sans-serif',
              fontSize: '13px'
            }
          });
        }
      }

      // 2. Process other code blocks with highlight.js
      document.querySelectorAll('pre code').forEach((block) => {
        if (block.classList.contains('language-mermaid')) return;
        
        if (typeof hljs !== 'undefined') {
          hljs.highlightElement(block);
        }
        
        const langClass = Array.from(block.classList).find(c => c.startsWith('language-'));
        const lang = langClass ? langClass.replace('language-', '') : 'code';
        const pre = block.parentElement;
        if (!pre) return;
        
        if (pre.parentElement && pre.parentElement.classList.contains('code-block')) return;
        
        const wrapper = document.createElement('div');
        wrapper.className = 'code-block';
        
        const header = document.createElement('div');
        header.className = 'code-header';
        header.innerHTML = '<span class="code-lang">' + lang + '</span><button class="copy-btn" onclick="copyCode(this)">copy</button>';
        
        pre.parentNode.insertBefore(wrapper, pre);
        wrapper.appendChild(header);
        wrapper.appendChild(pre);
      });
    });
  </script>
  <style>
    body { min-height: 100vh; height: auto; overflow: auto; padding: 0; }
    .artifact-page { max-width: 980px; width: 100%; margin: 0 auto; color: var(--text); padding: 28px; }
    .artifact-header { border-bottom: 1px solid var(--border); margin-bottom: 22px; padding-bottom: 16px; }
    .artifact-title { color: var(--accent-bright); font-size: 1.45rem; letter-spacing: 0; }
    .artifact-meta { color: var(--text-dim); font-family: var(--font-mono); font-size: 0.72rem; margin-top: 8px; }
    .mermaid { display: flex; justify-content: center; margin: 1.5rem 0; background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 16px; overflow-x: auto; }
    @media (max-width: 760px) {
      .artifact-page { padding: 22px; }
    }
  </style>
</head>
<body>
  <main class="artifact-page">
    <header class="artifact-header">
      <h1 class="artifact-title">${escapeHtml(title)}</h1>
      <div class="artifact-meta">Generated documentation</div>
    </header>
    <article class="md">
${bodyHtml}
    </article>
  </main>
</body>
</html>
`

export const indexShell = (manifest: DocsManifest): string => {
  return pageShell('Documentation Index', `
      <p>${escapeHtml(manifest.query)}</p>
      <p><em>Generated at ${escapeHtml(manifest.generatedAt)}</em></p>
`)
}



export const DocumentationTools = (): ActorDef<DocumentationMsg, DocumentationState> => {
  const handler: MessageHandler<DocumentationMsg, DocumentationState> = onMessage<DocumentationMsg, DocumentationState>({
    _done: (state) => ({ state }),

    'http.request': (state, message, ctx) => {
      const { request, identity, replyTo } = message
      const url = new URL(request.url, 'http://localhost')
      const path = url.pathname

      // Check session
      if (!identity) {
        replyTo.send({
          type: 'http.response',
          response: {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Unauthorized' }),
          }
        })
        return { state }
      }

      // /documentation/* prefix routing
      if (request.method === 'GET' && path.startsWith('/documentation/')) {
        const rawFilename = path.slice('/documentation/'.length) || 'index.html'
        let filename = 'index.html'
        try {
          filename = decodeURIComponent(rawFilename)
        } catch {}
        if (filename.includes('\0') || filename.includes('..')) {
          replyTo.send({
            type: 'http.response',
            response: {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ error: 'Not found' }),
            }
          })
          return { state }
        }

        // Send a getDoc message to self to fetch the content asynchronously
        ctx.self.send({
          type: 'getDoc',
          filename,
          replyTo: {
            name: 'http:documentation',
            isAlive: () => true,
            send: (res) => {
              if (!res.ok) {
                replyTo.send({
                  type: 'http.response',
                  response: {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Not found' }),
                  }
                })
              } else {
                const mimeType = (path: string): string => {
                  if (path.endsWith('.html')) return 'text/html; charset=utf-8'
                  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
                  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8'
                  if (path.endsWith('.json')) return 'application/json; charset=utf-8'
                  if (path.endsWith('.svg')) return 'image/svg+xml'
                  if (path.endsWith('.png')) return 'image/png'
                  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
                  return 'application/octet-stream'
                }
                replyTo.send({
                  type: 'http.response',
                  response: {
                    status: 200,
                    headers: { 'Content-Type': mimeType(filename) },
                    body: res.content,
                  }
                })
              }
            }
          }
        })
      } else {
        replyTo.send({
          type: 'http.response',
          response: {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Not found' }),
          }
        })
      }
      return { state }
    },

    _persistenceRef: (state, msg) => {
      return { state: { ...state, persistenceRef: msg.ref } }
    },

    getDoc: (state, msg, ctx) => {
      if (!state.persistenceRef) {
        msg.replyTo.send({ ok: false, error: 'Persistence not resolved' })
        return { state }
      }
      const dl = state.persistenceRef
      const loadDoc = async () => {
        const res = await ask<PersistenceMsg, PResult<string>>(dl, (replyTo) => ({
          type: 'doc.get',
          collection: 'documentation',
          docId: msg.filename,
          replyTo,
        }))
        if (res.ok && res.data) return res.data
        throw new Error('Document not found')
      }
      ctx.pipeToSelf(
        loadDoc(),
        (content) => {
          msg.replyTo.send({ ok: true, content })
          return { type: '_done' as const }
        },
        (err) => {
          msg.replyTo.send({ ok: false, error: String(err) })
          return { type: '_done' as const }
        }
      )
      return { state }
    },

    invoke: (state, msg, ctx) => {
      if (state.writing) {
        return { state, stash: true }
      }
      if (!state.persistenceRef) {
        msg.replyTo.send({ type: 'toolError', error: 'Persistence not ready' })
        return { state }
      }

      const parent = ctx.trace.fromHeaders()
      const span: SpanHandle | null = parent
        ? ctx.trace.child(parent.traceId, parent.spanId, msg.toolName, { toolName: msg.toolName })
        : null

      const dl = state.persistenceRef

      if (msg.toolName === writeDocPageTool.name) {
        const parsed = parseToolArgs<PageArgs>(msg.arguments, obj => {
          const title = obj.title
          const filename = obj.filename
          const summary = obj.summary
          const bodyHtml = obj.bodyHtml
          const sourcePaths = obj.sourcePaths
          if (typeof title !== 'string' || typeof filename !== 'string' || typeof summary !== 'string' || typeof bodyHtml !== 'string') return null
          if (!Array.isArray(sourcePaths) || !sourcePaths.every(p => typeof p === 'string')) return null
          return { title, filename, summary, bodyHtml, sourcePaths }
        })
        if (!parsed.ok) {
          msg.replyTo.send({ type: 'toolError', error: parsed.error })
          return { state }
        }
        const args = parsed.value
        const filename = safeFilename(args.filename)
        const meta: DocPageMeta = {
          title: args.title.trim(),
          filename,
          summary: args.summary.trim(),
          sourcePaths: args.sourcePaths,
          createdAt: new Date().toISOString(),
        }

        ctx.pipeToSelf(
          (async () => {
            const existingManifest = await readManifest(dl)

            const existingPages = existingManifest?.pages ?? []
            const updatedPages = [...existingPages.filter(p => p.filename !== filename), meta]

            const nextManifest: DocsManifest = {
              generatedAt: new Date().toISOString(),
              query: existingManifest?.query ?? 'Project Documentation',
              pages: updatedPages,
            }

            await ask<PersistenceMsg, PResult>(dl, (replyTo) => ({
              type: 'doc.put',
              collection: 'documentation',
              docId: filename,
              content: pageShell(meta.title, args.bodyHtml),
              replyTo,
            }))
            await ask<PersistenceMsg, PResult>(dl, (replyTo) => ({
              type: 'doc.put',
              collection: 'documentation',
              docId: 'manifest.json',
              content: JSON.stringify(nextManifest, null, 2),
              replyTo,
            }))
            await ask<PersistenceMsg, PResult>(dl, (replyTo) => ({
              type: 'doc.put',
              collection: 'documentation',
              docId: 'index.html',
              content: indexShell(nextManifest),
              replyTo,
            }))
          })(),
          () => ({ type: '_writeDone' as const, replyTo: msg.replyTo, text: `Wrote ${filename}`, span }),
          error => ({ type: '_writeErr' as const, replyTo: msg.replyTo, error: String(error), span }),
        )
        return { state: { ...state, writing: true } }
      }

      if (msg.toolName === deleteDocTool.name) {
        const parsed = parseToolArgs<{ filename: string }>(msg.arguments, obj => {
          const filename = obj.filename
          return typeof filename === 'string' && filename.trim() ? { filename: filename.trim() } : null
        })
        if (!parsed.ok) {
          msg.replyTo.send({ type: 'toolError', error: parsed.error })
          return { state }
        }
        const filename = safeFilename(parsed.value.filename)

        ctx.pipeToSelf(
          (async () => {
            const existingManifest = await readManifest(dl)
            const existingPages = existingManifest?.pages ?? []
            const nextManifest: DocsManifest = {
              generatedAt: new Date().toISOString(),
              query: existingManifest?.query ?? 'Project Documentation',
              pages: existingPages.filter(p => p.filename !== filename),
            }

            await ask<PersistenceMsg, PResult>(dl, (replyTo) => ({
              type: 'doc.delete',
              collection: 'documentation',
              docId: filename,
              replyTo,
            }))
            await ask<PersistenceMsg, PResult>(dl, (replyTo) => ({
              type: 'doc.put',
              collection: 'documentation',
              docId: 'manifest.json',
              content: JSON.stringify(nextManifest, null, 2),
              replyTo,
            }))
            await ask<PersistenceMsg, PResult>(dl, (replyTo) => ({
              type: 'doc.put',
              collection: 'documentation',
              docId: 'index.html',
              content: indexShell(nextManifest),
              replyTo,
            }))
          })(),
          () => ({ type: '_writeDone' as const, replyTo: msg.replyTo, text: `Deleted ${filename}`, span }),
          error => ({ type: '_writeErr' as const, replyTo: msg.replyTo, error: String(error), span }),
        )
        return { state: { ...state, writing: true } }
      }

      if (msg.toolName === writeTocTool.name) {
        const parsed = parseToolArgs<{ toc: TocNode[] }>(msg.arguments, obj => {
          const toc = obj.toc
          if (!Array.isArray(toc)) return null
          return { toc }
        })
        if (!parsed.ok) {
          msg.replyTo.send({ type: 'toolError', error: parsed.error })
          return { state }
        }
        const { toc } = parsed.value

        ctx.pipeToSelf(
          (async () => {
            await ask<PersistenceMsg, PResult>(dl, (replyTo) => ({
              type: 'doc.put',
              collection: 'documentation',
              docId: 'toc.json',
              content: JSON.stringify(toc, null, 2),
              replyTo,
            }))
          })(),
          () => ({ type: '_writeDone' as const, replyTo: msg.replyTo, text: 'Wrote table of contents (toc.json)', span }),
          error => ({ type: '_writeErr' as const, replyTo: msg.replyTo, error: String(error), span }),
        )
        return { state: { ...state, writing: true } }
      }

      msg.replyTo.send({ type: 'toolError', error: `Unknown tool: ${msg.toolName}` })
      return { state }
    },

    _writeDone: (state, msg) => {
      msg.span?.done()
      msg.replyTo.send({ type: 'toolResult', result: { text: msg.text } })
      return { state: { ...state, writing: false }, become: handler, unstashAll: true }
    },

    _writeErr: (state, msg) => {
      msg.span?.error(msg.error)
      msg.replyTo.send({ type: 'toolError', error: msg.error })
      return { state: { ...state, writing: false }, become: handler, unstashAll: true }
    },
  })

  return {
    initialState: () => ({ writing: false, persistenceRef: null }),
    handler,

    lifecycle: onLifecycle({
      start: (state, context) => {
        context.subscribe(PersistenceProviderTopic, (event) => ({
          type: '_persistenceRef' as const,
          ref: event.ref,
        }))
        return { state }
      },
    }),
  }
}
