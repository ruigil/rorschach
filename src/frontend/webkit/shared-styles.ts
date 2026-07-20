import { css } from './base.js';

export const sharedStyles = css`
  :host {
    box-sizing: border-box;
  }

  /* Custom Webkit scrollbar styles */
  ::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }
  ::-webkit-scrollbar-track {
    background: transparent;
  }
  ::-webkit-scrollbar-thumb {
    background: var(--scrollbar-thumb);
    border-radius: 3px;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: var(--scrollbar-thumb-hover);
  }

  /* Typography utilities */
  .text-mono {
    font-family: var(--font-mono, monospace);
  }
  .text-dim {
    color: var(--text-dim);
  }

  /* Layout helpers */
  .flex-column {
    display: flex;
    flex-direction: column;
  }
  .flex-row {
    display: flex;
    flex-direction: row;
  }
  .flex-grow-1 {
    flex: 1;
    min-height: 0;
  }
`;

export const workspaceStyles = css`
  :host {
    display: block;
    height: 100%;
    width: 100%;
  }

  [hidden] {
    display: none !important;
  }

  .ws-header-title {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    height: 100%;
  }

  .ws-title-base {
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim);
    font-family: var(--font-ui);
  }

  .ws-title-sep {
    font-size: 0.75rem;
    color: var(--text-dim);
    opacity: 0.5;
  }

  .ws-title-active {
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--accent);
    background: var(--accent-dim);
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    border: 1px solid var(--accent-glow);
    font-family: var(--font-ui);
  }

  .ws-body {
    display: grid;
    grid-template-columns: 240px 1fr;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    width: 100%;
    height: 100%;
  }

  .ws-sidebar {
    display: flex;
    flex-direction: column;
    background: var(--sidebar-bg, var(--surface));
    border-right: 1px solid var(--border);
    overflow: hidden;
    user-select: none;
  }

  .ws-sidebar-tree {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0.35rem;
  }

  .ws-sidebar-tree::-webkit-scrollbar { width: 3px; }
  .ws-sidebar-tree::-webkit-scrollbar-track { background: transparent; }
  .ws-sidebar-tree::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 2px; }

  .ws-main {
    display: flex;
    flex-direction: column;
    flex: 1;
    height: 100%;
    overflow: hidden;
    min-width: 0;
    background: var(--bg);
  }
`;

