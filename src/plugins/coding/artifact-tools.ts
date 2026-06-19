import { mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActorDef, ActorRef, MessageHandler, SpanHandle } from '../../system/index.ts'
import { defineTool, onMessage, parseToolArgs } from '../../system/index.ts'
import type { ToolReply } from '../../types/tools.ts'
import type { ArtifactState, ArtifactToolsMsg, DocPageMeta, DocsManifest } from './types.ts'

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

const readManifest = async (artifactsDir: string): Promise<DocsManifest | null> => {
  const file = Bun.file(join(artifactsDir, 'manifest.json'))
  if (!(await file.exists())) return null
  try {
    const raw = await file.text()
    const parsed = JSON.parse(raw) as Partial<DocsManifest>
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

const tocSidebar = (): string => `
      <aside class="artifact-sidebar" aria-label="Table of contents">
        <h2>Table of Contents</h2>
        <ol id="toc-list">
          <li><span>Loading table of contents...</span></li>
        </ol>
      </aside>`

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
  <script src="./toc.js" defer></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
  <script>
    function copyCode(btn) {
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
    html { scrollbar-width: thin; scrollbar-color: var(--border-mid) transparent; }
    body { min-height: 100vh; height: auto; overflow: auto; padding: 0; }
    body::-webkit-scrollbar, .artifact-sidebar::-webkit-scrollbar { width: 4px; height: 4px; }
    body::-webkit-scrollbar-track, .artifact-sidebar::-webkit-scrollbar-track { background: transparent; }
    body::-webkit-scrollbar-thumb, .artifact-sidebar::-webkit-scrollbar-thumb { background: var(--border-mid); border-radius: 2px; }
    body::-webkit-scrollbar-thumb:hover, .artifact-sidebar::-webkit-scrollbar-thumb:hover { background: var(--muted); }
    .artifact-layout { display: grid; grid-template-columns: minmax(190px, 240px) minmax(0, 1fr); min-height: 100vh; }
    .artifact-sidebar { position: sticky; top: 0; align-self: start; min-height: 100vh; max-height: 100vh; overflow: auto; scrollbar-width: thin; scrollbar-color: var(--border-mid) transparent; border-right: 1px solid var(--border); padding: 24px 18px; background: rgba(6, 14, 20, 0.86); }
    .artifact-sidebar h2 { color: var(--text-dim); font-family: var(--font-mono); font-size: 0.72rem; font-weight: 600; letter-spacing: 0; margin: 18px 0 10px; text-transform: uppercase; }
    .artifact-sidebar ol { display: grid; gap: 8px; list-style: none; margin: 0; padding: 0; }
    .artifact-sidebar a, .artifact-sidebar span { color: var(--text); display: block; font-size: 0.9rem; line-height: 1.35; text-decoration: none; }
    .artifact-sidebar a:hover, .artifact-sidebar a[aria-current="page"] { color: var(--accent-bright); }
    .artifact-page { max-width: 980px; width: 100%; margin: 0 auto; color: var(--text); padding: 28px; }
    .artifact-header { border-bottom: 1px solid var(--border); margin-bottom: 22px; padding-bottom: 16px; }
    .artifact-title { color: var(--accent-bright); font-size: 1.45rem; letter-spacing: 0; }
    .artifact-meta { color: var(--text-dim); font-family: var(--font-mono); font-size: 0.72rem; margin-top: 8px; }
    .mermaid { display: flex; justify-content: center; margin: 1.5rem 0; background: rgba(6, 14, 20, 0.4); border: 1px solid var(--border); border-radius: 6px; padding: 16px; overflow-x: auto; }
    @media (max-width: 760px) {
      .artifact-layout { display: block; }
      .artifact-sidebar { position: static; min-height: auto; max-height: none; border-right: 0; border-bottom: 1px solid var(--border); }
      .artifact-page { padding: 22px; }
    }
  </style>
</head>
<body>
  <div class="artifact-layout">
${tocSidebar()}
    <main class="artifact-page">
      <header class="artifact-header">
        <h1 class="artifact-title">${escapeHtml(title)}</h1>
        <div class="artifact-meta">Generated documentation</div>
      </header>
      <article class="md">
${bodyHtml}
      </article>
    </main>
  </div>
</body>
</html>
`

export const indexShell = (manifest: DocsManifest): string => {
  return pageShell('Documentation Index', `
      <p>${escapeHtml(manifest.query)}</p>
      <p><em>Generated at ${escapeHtml(manifest.generatedAt)}</em></p>
`)
}

const tocScript = `(async () => {
  try {
    const res = await fetch('./manifest.json');
    if (!res.ok) throw new Error('Failed to load manifest');
    const manifest = await res.json();
    const list = document.getElementById('toc-list');
    if (!list || !manifest.pages) return;
    
    const currentFile = window.location.pathname.split('/').pop() || 'index.html';
    list.innerHTML = manifest.pages.map(page => {
      const isActive = page.filename === currentFile || (currentFile === '' && page.filename === 'index.html');
      const activeAttr = isActive ? ' aria-current="page"' : '';
      const escapedTitle = page.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const escapedFilename = page.filename.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      return \`<li><a href="./\${escapedFilename}"\${activeAttr}>\${escapedTitle}</a></li>\`;
    }).join('\\n') || '<li><span>No pages generated.</span></li>';
  } catch (err) {
    console.error('Error rendering TOC:', err);
    const list = document.getElementById('toc-list');
    if (list) list.innerHTML = '<li><span style="color:var(--accent-bright)">Failed to load TOC</span></li>';
  }
})();`

export const ArtifactTools = (artifactsDir: string): ActorDef<ArtifactToolsMsg, ArtifactState> => {
  const handler: MessageHandler<ArtifactToolsMsg, ArtifactState> = onMessage<ArtifactToolsMsg, ArtifactState>({
    _done: (state) => ({ state }),

    invoke: (state, msg, ctx) => {
      if (state.writing) {
        return { state, stash: true }
      }

      const parent = ctx.trace.fromHeaders()
      const span: SpanHandle | null = parent
        ? ctx.trace.child(parent.traceId, parent.spanId, msg.toolName, { toolName: msg.toolName })
        : null

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
            await mkdir(artifactsDir, { recursive: true })
            const existingManifest = await readManifest(artifactsDir)
            
            const existingPages = existingManifest?.pages ?? []
            const updatedPages = [...existingPages.filter(p => p.filename !== filename), meta]
            
            const nextManifest: DocsManifest = {
              generatedAt: new Date().toISOString(),
              query: existingManifest?.query ?? 'Project Documentation',
              pages: updatedPages,
            }

            await Bun.write(join(artifactsDir, filename), pageShell(meta.title, args.bodyHtml))
            await Bun.write(join(artifactsDir, 'manifest.json'), JSON.stringify(nextManifest, null, 2))
            await Bun.write(join(artifactsDir, 'index.html'), indexShell(nextManifest))
            await Bun.write(join(artifactsDir, 'toc.js'), tocScript)
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
            await mkdir(artifactsDir, { recursive: true })
            const existingManifest = await readManifest(artifactsDir)
            if (!existingManifest) return

            const existingPages = existingManifest.pages
            const updatedPages = existingPages.filter(p => p.filename !== filename)

            const nextManifest: DocsManifest = {
              generatedAt: new Date().toISOString(),
              query: existingManifest.query,
              pages: updatedPages,
            }

            try {
              await unlink(join(artifactsDir, filename))
            } catch {}

            await Bun.write(join(artifactsDir, 'manifest.json'), JSON.stringify(nextManifest, null, 2))
            await Bun.write(join(artifactsDir, 'index.html'), indexShell(nextManifest))
            await Bun.write(join(artifactsDir, 'toc.js'), tocScript)
          })(),
          () => ({ type: '_writeDone' as const, replyTo: msg.replyTo, text: `Deleted ${filename}`, span }),
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
    initialState: () => ({ writing: false }),
    handler,
  }
}
