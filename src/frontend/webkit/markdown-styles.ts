// Shared markdown CSS as a Lit CSSResult.
//
// `r-message-bubble` renders markdown HTML via `renderMarkdown()` inside its
// shadow root. These styles — `.md`, `.code-block`, `.reasoning`, etc. — must
// be available in the shadow root. Exporting them as a shared `CSSResult`
// avoids duplicating 256 lines of CSS and lets any future component that
// renders markdown reuse them via `static styles = [markdownStyles, ...]`.

import { css } from 'lit';

export const markdownStyles = css`
  .md {
    line-height: 1.8;
    white-space: normal;
    font-size: inherit;
    font-family: inherit;
    font-weight: inherit;
  }
  .md > *:first-child { margin-top: 0; }
  .md p { margin-bottom: 0.82em; }
  .md p:last-child { margin-bottom: 0; }

  .md h1, .md h2, .md h3 {
    font-family: var(--font-ui);
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--accent-bright);
    margin: 1.4em 0 0.5em;
    padding-bottom: 0.3em;
    border-bottom: 1px solid var(--border);
  }
  .md h1 { font-size: 1.1em; }
  .md h2 { font-size: 0.97em; }
  .md h3 { font-size: 0.88em; border-bottom: none; color: var(--text-mid); }

  .md ul, .md ol { padding-left: 1.4em; margin: 0 0 0.75em; }
  .md li { margin: 0; padding: 0; }
  .md li + li { margin-top: 0.97em; }
  .md li p { margin: 0 !important; }
  .md li > ul, .md li > ol { margin: 0.35em 0 0; }
  .md ul ul, .md ol ul, .md ul ol, .md ol ol { margin-bottom: 0; }
  .md ul li::marker { color: var(--accent); }

  .md blockquote {
    border-left: 2px solid var(--accent);
    padding: 0.1em 0 0.1em 1em;
    margin: 0.8em 0;
    color: var(--text-mid);
    font-style: italic;
  }

  .md a { color: var(--accent-bright); text-decoration: none; border-bottom: 1px solid var(--accent-dim); }
  .md a:hover { border-color: var(--accent); }

  .md strong { color: var(--text); font-weight: 700; }
  .md em { color: var(--text-mid); }

  .md hr { border: none; border-top: 1px solid var(--border); margin: 1.2em 0; }

  .md img {
    max-width: 100%;
    height: auto;
    border-radius: var(--radius);
    display: block;
    margin: 0.5em 0;
  }

  .md code {
    font-family: var(--font-mono);
    font-size: 0.82em;
    background: var(--surface-2);
    border: 1px solid var(--border-mid);
    border-radius: 4px;
    padding: 0.12em 0.4em;
    color: var(--accent-bright);
  }

  .code-block {
    margin: 0.9em 0;
    border: 1px solid var(--border-mid);
    border-radius: var(--radius);
    overflow: hidden;
    background: var(--surface-2);
  }
  .code-block:first-child { margin-top: 0; }
  .code-block:last-child { margin-bottom: 0; }

  .code-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.38rem 0.85rem;
    background: rgba(22, 46, 63, 0.55);
    border-bottom: 1px solid var(--border);
  }

  .code-lang {
    font-family: var(--font-mono);
    font-size: 0.66rem;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent);
  }

  .copy-btn {
    font-family: var(--font-mono);
    font-size: 0.64rem;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    background: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.15rem 0.5rem;
    cursor: pointer;
    transition: color 0.14s, border-color 0.14s;
  }
  .copy-btn:hover { color: var(--accent); border-color: var(--accent-dim); }

  .code-block pre {
    margin: 0;
    padding: 0.85rem 1rem;
    overflow-x: auto;
    background: transparent !important;
    scrollbar-width: thin;
    scrollbar-color: var(--border-mid) transparent;
  }

  .code-block pre::-webkit-scrollbar { height: 4px; }
  .code-block pre::-webkit-scrollbar-track { background: transparent; }
  .code-block pre::-webkit-scrollbar-thumb { background: var(--border-mid); border-radius: 2px; }
  .code-block pre::-webkit-scrollbar-thumb:hover { background: var(--muted); }

  .code-block pre code {
    font-family: var(--font-mono);
    font-size: 0.79rem;
    line-height: 1.62;
    background: none !important;
    border: none !important;
    padding: 0 !important;
    border-radius: 0;
    color: inherit;
  }

  .hljs { background: transparent !important; }

  .md table {
    width: 100%;
    border-collapse: collapse;
    margin: 0.9em 0;
    font-size: 0.84em;
  }
  .md th {
    background: var(--surface-2);
    color: var(--text-mid);
    font-weight: 600;
    letter-spacing: 0.05em;
    padding: 0.45em 0.8em;
    border: 1px solid var(--border-mid);
    text-align: left;
  }
  .md td {
    padding: 0.4em 0.8em;
    border: 1px solid var(--border);
    color: var(--text);
  }
  .md tr:nth-child(even) td { background: rgba(16, 36, 52, 0.35); }

  .video-container {
    position: relative;
    width: 100%;
    padding-bottom: 56.25%;
    height: 0;
    margin: 0.8rem 0;
    background: var(--surface-2);
    border-radius: var(--radius);
    overflow: hidden;
    border: 1px solid var(--border-mid);
  }

  .video-container iframe {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
  }

  .reasoning {
    margin-bottom: 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
    font-size: 0.78rem;
  }

  .reasoning summary {
    padding: 5px 10px;
    cursor: pointer;
    color: var(--text-dim);
    user-select: none;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .reasoning summary::-webkit-details-marker { display: none; }

  .reasoning summary::before {
    content: '▶';
    font-size: 0.55em;
    opacity: 0.6;
    transition: transform 0.15s ease;
  }

  .reasoning[open] summary::before {
    transform: rotate(90deg);
  }

  .reasoning[open] summary {
    border-bottom: 1px solid var(--border);
  }

  .reasoning-content {
    padding: 10px 12px;
    color: var(--text-dim);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 280px;
    overflow-y: auto;
    margin: 0;
    font-family: var(--font-mono);
    font-size: 0.72rem;
    line-height: 1.55;
    opacity: 0.8;
    scrollbar-width: thin;
    scrollbar-color: var(--border-mid) transparent;
  }

  .reasoning-content::-webkit-scrollbar { width: 4px; }
  .reasoning-content::-webkit-scrollbar-track { background: transparent; }
  .reasoning-content::-webkit-scrollbar-thumb { background: var(--border-mid); border-radius: 2px; }
  .reasoning-content::-webkit-scrollbar-thumb:hover { background: var(--muted); }

  @keyframes reasoning-glow {
    0%, 100% { color: var(--text-dim); text-shadow: none; }
    50% { color: var(--accent-bright); text-shadow: 0 0 8px var(--accent-glow); }
  }

  .reasoning-streaming summary {
    color: var(--accent);
    animation: reasoning-glow 1.8s ease-in-out infinite;
  }
`;
