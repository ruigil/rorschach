import { marked } from 'marked'
import type { ActorDef, ActorRef, MessageHandler, SpanHandle } from '../../system/index.ts'
import { defineTool, onMessage, parseToolArgs, onLifecycle, ask } from '../../system/index.ts'
import type { ToolReply } from '../../types/tools.ts'
import type { PageToolsState, PageToolsMsg, TocNode } from './types.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult } from '../../types/persistence.ts'

export const writeHTMLPageTool = defineTool('write_html_page', 'Write an HTML page generated from Markdown into a persistence collection, automatically updating the table of contents.', {
  type: 'object',
  required: ['collection', 'title', 'filename', 'markdown'],
  properties: {
    collection: { type: 'string', description: 'Target persistence doc collection name (e.g. "documentation").' },
    title: { type: 'string', description: 'Page title.' },
    filename: { type: 'string', description: 'HTML filename or relative path, e.g. architecture.html or guides/getting-started.html.' },
    markdown: { type: 'string', description: 'Markdown source content for the page body.' },
  },
})

type WriteHTMLPageArgs = {
  collection: string
  title: string
  filename: string
  markdown: string
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export const safePathFilename = (filename: string): string => {
  const parts = filename
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter(p => p !== '' && p !== '..')

  if (parts.length === 0) return 'page.html'

  const lastIndex = parts.length - 1
  let leaf = parts[lastIndex]!
  if (!leaf.endsWith('.html')) {
    leaf = `${leaf}.html`
  }
  parts[lastIndex] = leaf.replace(/[^a-zA-Z0-9._-]/g, '-')

  for (let i = 0; i < lastIndex; i++) {
    parts[i] = parts[i]!.replace(/[^a-zA-Z0-9._-]/g, '-')
  }

  return parts.join('/')
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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:ital,wght@0,400;0,500;1,400&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/style.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/base16/ocean.min.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
  <script>
    (function() {
      function syncTheme() {
        let theme = 'eclipse';
        try {
          if (window.parent && window.parent.document && window.parent.document.documentElement) {
            const pt = window.parent.document.documentElement.dataset.theme;
            if (pt) theme = pt;
          }
        } catch(e) {}
        if (!theme || theme === 'eclipse') {
          try {
            const raw = localStorage.getItem('rorschach.store.shell.theme');
            if (raw) {
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === 'string') theme = parsed;
            }
          } catch(e) {}
        }
        document.documentElement.setAttribute('data-theme', theme || 'eclipse');
        return theme || 'eclipse';
      }
      syncTheme();
      window.__rorschachSyncTheme = syncTheme;
    })();
  </script>
  <script>
    const copyCode = (btn) => {
      const codeBlock = btn.closest('.code-block');
      if (!codeBlock) return;
      const codeEl = codeBlock.querySelector('code');
      if (!codeEl) return;
      const code = codeEl.textContent || '';
      navigator.clipboard.writeText(code).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'copied ✓';
        btn.style.color = 'var(--green)';
        setTimeout(() => {
          btn.textContent = orig;
          btn.style.color = '';
        }, 1800);
      });
    };

    const copyDocumentText = (btn) => {
      const article = document.querySelector('article.md');
      if (!article) return;
      navigator.clipboard.writeText(article.innerText || '').then(() => {
        const orig = btn.innerHTML;
        btn.innerHTML = '<span>copied ✓</span>';
        setTimeout(() => { btn.innerHTML = orig; }, 1800);
      });
    };

    function initMermaid(themeName) {
      if (typeof mermaid === 'undefined') return;
      const isLight = themeName === 'light';
      mermaid.initialize({
        startOnLoad: true,
        theme: isLight ? 'default' : 'dark',
        themeVariables: isLight ? {
          background: '#ffffff',
          primaryColor: '#eef2f6',
          primaryTextColor: '#0a1820',
          lineColor: '#b0bcc7',
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: '13px'
        } : {
          background: '#060e14',
          primaryColor: '#0ea5e9',
          primaryTextColor: '#f8fafc',
          lineColor: '#334155',
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: '13px'
        }
      });
    }

    document.addEventListener('DOMContentLoaded', () => {
      const currentTheme = window.__rorschachSyncTheme ? window.__rorschachSyncTheme() : 'eclipse';

      // 1. Listen for theme updates from parent / storage
      window.addEventListener('storage', (e) => {
        if (e.key === 'rorschach.store.shell.theme') {
          if (window.__rorschachSyncTheme) window.__rorschachSyncTheme();
        }
      });

      try {
        if (window.parent && window.parent.document) {
          const obs = new MutationObserver(() => {
            if (window.__rorschachSyncTheme) window.__rorschachSyncTheme();
          });
          obs.observe(window.parent.document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme']
          });
        }
      } catch(e) {}

      // 2. Transform mermaid code blocks
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
        initMermaid(currentTheme);
      }

      // 3. Process other code blocks with highlight.js
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

      // 4. Generate Table of Contents (Outline)
      const article = document.querySelector('article.md');
      const tocList = document.getElementById('toc-list');
      if (article && tocList) {
        const headings = article.querySelectorAll('h1, h2, h3');
        if (headings.length > 0) {
          headings.forEach((heading, idx) => {
            if (!heading.id) {
              heading.id = 'heading-' + idx + '-' + heading.textContent.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            }
            const li = document.createElement('li');
            const level = heading.tagName.toLowerCase() === 'h1' ? '1' : (heading.tagName.toLowerCase() === 'h2' ? '2' : '3');
            li.className = 'toc-item level-' + level;
            
            const a = document.createElement('a');
            a.className = 'toc-link';
            a.href = '#' + heading.id;
            a.textContent = heading.textContent;
            li.appendChild(a);
            tocList.appendChild(li);
          });

          // Scroll spy for TOC links
          const observerOptions = { rootMargin: '-80px 0px -60% 0px', threshold: 0 };
          const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
              if (entry.isIntersecting) {
                const id = entry.target.id;
                document.querySelectorAll('.toc-link').forEach(link => {
                  link.classList.toggle('active', link.getAttribute('href') === '#' + id);
                });
              }
            });
          }, observerOptions);

          headings.forEach(h => observer.observe(h));
        } else {
          const sidebar = document.querySelector('.toc-sidebar');
          if (sidebar) sidebar.style.display = 'none';
        }
      }
    });
  </script>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html { background: var(--bg, #03070a); color-scheme: dark light; scroll-behavior: smooth; }
    body {
      min-height: 100vh;
      height: auto;
      overflow-x: hidden;
      overflow-y: auto;
      padding: 0;
      margin: 0;
      font-family: var(--font-ui, 'Space Grotesk', system-ui, sans-serif);
      color: var(--text, #e8f6fa);
      background: var(--bg, #03070a);
      position: relative;
    }

    /* Ambient background glow */
    body::before {
      content: '';
      position: fixed;
      top: -120px;
      left: 50%;
      transform: translateX(-50%);
      width: 800px;
      height: 350px;
      background: radial-gradient(circle, var(--accent-glow, rgba(0, 196, 212, 0.15)) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
      opacity: 0.6;
    }

    /* Custom WebKit Scrollbars */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb, rgba(255, 255, 255, 0.1)); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-thumb-hover, rgba(255, 255, 255, 0.2)); }

    /* Sticky Glass Topbar */
    .top-header {
      position: sticky;
      top: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1.5rem;
      background: var(--glass-bg, rgba(6, 14, 20, 0.75));
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border, #0d1f2d);
      transition: background 0.2s ease, border-color 0.2s ease;
    }
    .top-header-left {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      min-width: 0;
    }
    .doc-title-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-family: var(--font-ui, 'Space Grotesk', system-ui, sans-serif);
      font-size: 0.76rem;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--accent-bright, #22e8f8);
      background: var(--accent-dim, rgba(0, 196, 212, 0.06));
      border: 1px solid var(--accent-glow, rgba(0, 196, 212, 0.25));
      padding: 0.25rem 0.65rem;
      border-radius: 6px;
      white-space: nowrap;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Page Layout Container */
    .doc-layout-wrapper {
      max-width: 1140px;
      margin: 0 auto;
      padding: 2rem 1.5rem 4rem;
      position: relative;
      z-index: 1;
    }
    .doc-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 220px;
      gap: 2rem;
      align-items: start;
    }
    @media (max-width: 960px) {
      .doc-grid { grid-template-columns: minmax(0, 1fr); }
      .toc-sidebar { display: none; }
    }

    /* Artifact Card Document */
    .artifact-page {
      background: var(--surface, #060e14);
      border: 1px solid var(--border, #0d1f2d);
      border-radius: var(--radius, 12px);
      padding: 2.25rem 2.5rem;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
      transition: border-color 0.2s ease, background 0.2s ease;
    }
    .artifact-header {
      border-bottom: 1px solid var(--border-mid, #1a3548);
      margin-bottom: 2rem;
      padding-bottom: 1.25rem;
    }
    .artifact-title {
      color: var(--accent-bright, #22e8f8);
      font-size: 1.85rem;
      font-weight: 700;
      letter-spacing: -0.01em;
      line-height: 1.25;
      margin: 0 0 0.5rem 0;
    }
    .artifact-meta {
      display: flex;
      align-items: center;
      gap: 1rem;
      color: var(--text-dim, #3d6878);
      font-family: var(--font-mono, monospace);
      font-size: 0.74rem;
    }

    /* Outline / TOC Sidebar */
    .toc-sidebar {
      position: sticky;
      top: 5rem;
      background: var(--surface, #060e14);
      border: 1px solid var(--border, #0d1f2d);
      border-radius: var(--radius, 8px);
      padding: 1rem;
      max-height: calc(100vh - 7rem);
      overflow-y: auto;
    }
    .toc-title {
      font-family: var(--font-mono, monospace);
      font-size: 0.65rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text-dim, #3d6878);
      margin-bottom: 0.75rem;
      padding-bottom: 0.35rem;
      border-bottom: 1px solid var(--border, #0d1f2d);
    }
    .toc-list { list-style: none; padding: 0; margin: 0; }
    .toc-item { margin: 0.35rem 0; }
    .toc-item.level-2 { padding-left: 0.6rem; }
    .toc-item.level-3 { padding-left: 1.2rem; }
    .toc-link {
      color: var(--text-mid, #8abccc);
      font-size: 0.74rem;
      text-decoration: none;
      display: block;
      line-height: 1.4;
      transition: color 0.14s ease;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .toc-link:hover, .toc-link.active {
      color: var(--accent-bright, #22e8f8);
    }
    .toc-link.active {
      font-weight: 600;
    }

    /* Mermaid Diagrams Styling */
    .mermaid {
      display: flex;
      justify-content: center;
      margin: 1.75rem 0;
      background: var(--surface-2, #0a1820);
      border: 1px solid var(--border-mid, #1a3548);
      border-radius: var(--radius, 8px);
      padding: 1.25rem;
      overflow-x: auto;
    }

    /* Markdown Body Tweaks & Callouts */
    .md blockquote {
      border-left: 3px solid var(--accent, #00c4d4);
      background: var(--accent-dim, rgba(0, 196, 212, 0.04));
      border-radius: 0 6px 6px 0;
      padding: 0.75rem 1.2rem;
      margin: 1.2rem 0;
      color: var(--text, #e8f6fa);
    }
    @media print {
      .top-header, .toc-sidebar { display: none !important; }
      .doc-layout-wrapper { padding: 0; max-width: 100%; }
      .artifact-page { border: none; box-shadow: none; padding: 0; }
    }
  </style>
</head>
<body>
  <header class="top-header">
    <div class="top-header-left">
      <span class="doc-title-badge">${escapeHtml(title)}</span>
    </div>
  </header>

  <div class="doc-layout-wrapper">
    <div class="doc-grid">
      <main class="artifact-page">
        <article class="md">
${bodyHtml}
        </article>
      </main>

      <aside class="toc-sidebar">
        <div class="toc-title">ON THIS PAGE</div>
        <ul class="toc-list" id="toc-list"></ul>
      </aside>
    </div>
  </div>
</body>
</html>
`

const formatSegmentTitle = (segment: string): string => {
  return segment
    .split(/[-_]/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || segment
}

export const updateTocTree = (tree: TocNode[], cleanPath: string, pageTitle: string): TocNode[] => {
  const parts = cleanPath.split('/')
  const leafFilename = cleanPath

  let currentLevel = tree
  for (let i = 0; i < parts.length - 1; i++) {
    const folderSegment = parts[i]!
    const folderTitle = formatSegmentTitle(folderSegment)

    let folderNode = currentLevel.find(n => !n.filename && n.title.toLowerCase() === folderTitle.toLowerCase())
    if (!folderNode) {
      folderNode = { title: folderTitle, children: [] }
      currentLevel.push(folderNode)
    }
    if (!folderNode.children) {
      folderNode.children = []
    }
    currentLevel = folderNode.children
  }

  const existingNode = currentLevel.find(n => n.filename === leafFilename)
  if (existingNode) {
    existingNode.title = pageTitle
  } else {
    currentLevel.push({ title: pageTitle, filename: leafFilename })
  }

  return tree
}

export const PageTools = (): ActorDef<PageToolsMsg, PageToolsState> => {
  const handler: MessageHandler<PageToolsMsg, PageToolsState> = onMessage<PageToolsMsg, PageToolsState>({
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
                const mimeType = (pathStr: string): string => {
                  if (pathStr.endsWith('.html')) return 'text/html; charset=utf-8'
                  if (pathStr.endsWith('.css')) return 'text/css; charset=utf-8'
                  if (pathStr.endsWith('.js')) return 'text/javascript; charset=utf-8'
                  if (pathStr.endsWith('.json')) return 'application/json; charset=utf-8'
                  if (pathStr.endsWith('.svg')) return 'image/svg+xml'
                  if (pathStr.endsWith('.png')) return 'image/png'
                  if (pathStr.endsWith('.jpg') || pathStr.endsWith('.jpeg')) return 'image/jpeg'
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

      if (msg.toolName === writeHTMLPageTool.name) {
        const parsed = parseToolArgs<WriteHTMLPageArgs>(msg.arguments, obj => {
          const collection = obj.collection
          const title = obj.title
          const filename = obj.filename
          const markdown = obj.markdown
          if (typeof collection !== 'string' || !collection.trim()) return null
          if (typeof title !== 'string' || !title.trim()) return null
          if (typeof filename !== 'string' || !filename.trim()) return null
          if (typeof markdown !== 'string') return null
          return {
            collection: collection.trim(),
            title: title.trim(),
            filename: filename.trim(),
            markdown,
          }
        })
        if (!parsed.ok) {
          msg.replyTo.send({ type: 'toolError', error: parsed.error })
          return { state }
        }

        const { collection, title, filename, markdown } = parsed.value
        const cleanFilename = safePathFilename(filename)
        const fullPath = `/${collection}/${cleanFilename}`

        ctx.pipeToSelf(
          (async () => {
            const bodyHtml = await Promise.resolve(marked.parse(markdown))
            const fullHtml = pageShell(title, bodyHtml)

            // 1. Put the page HTML
            await ask<PersistenceMsg, PResult>(dl, (replyTo) => ({
              type: 'doc.put',
              collection,
              docId: cleanFilename,
              content: fullHtml,
              replyTo,
            }))

            // 2. Fetch existing toc.json
            let currentToc: TocNode[] = []
            const tocRes = await ask<PersistenceMsg, PResult<string>>(dl, (replyTo) => ({
              type: 'doc.get',
              collection,
              docId: 'toc.json',
              replyTo,
            }))
            if (tocRes.ok && tocRes.data) {
              try {
                const parsedToc = JSON.parse(tocRes.data)
                if (Array.isArray(parsedToc)) {
                  currentToc = parsedToc
                }
              } catch {}
            }

            // 3. Update TOC tree incrementally
            const updatedToc = updateTocTree(currentToc, cleanFilename, title)

            // 4. Put updated toc.json
            await ask<PersistenceMsg, PResult>(dl, (replyTo) => ({
              type: 'doc.put',
              collection,
              docId: 'toc.json',
              content: JSON.stringify(updatedToc, null, 2),
              replyTo,
            }))
          })(),
          () => ({ type: '_writeDone' as const, replyTo: msg.replyTo, text: `wrote ${fullPath}`, span }),
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
