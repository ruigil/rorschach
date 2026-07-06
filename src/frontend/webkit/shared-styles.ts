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
