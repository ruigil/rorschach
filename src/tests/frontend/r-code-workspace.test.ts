import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mountClass, cleanup } from '../helpers/frontend.js';
import { RCodeWorkspace } from '../../plugins/coding/ui/r-code-workspace.js';

beforeEach(cleanup);
afterEach(cleanup);

describe('r-code-workspace', () => {
  test('defaults active tab to docs and renders Documentation before Bash', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () => ({ ok: true, json: async () => [] })) as any;

    try {
      const el = await mountClass(RCodeWorkspace) as RCodeWorkspace;
      await el.updateComplete;

      expect((el as any)._activeTab).toBe('docs');

      const buttons = Array.from(el.shadowRoot!.querySelectorAll('r-tabs button')) as HTMLButtonElement[];
      expect(buttons).toHaveLength(2);
      expect(buttons[0].dataset.tab).toBe('docs');
      expect(buttons[1].dataset.tab).toBe('bash');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('renders collection root node in r-tree and removes title header from sidebar', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (url: string) => {
      if (url === '/documentation/toc.json') {
        return {
          ok: true,
          json: async () => [
            { title: 'Overview', filename: 'index.html' },
            { title: 'Getting Started', filename: 'getting-started.html' }
          ]
        } as any;
      }
      return { ok: false } as any;
    }) as any;

    try {
      const el = await mountClass(RCodeWorkspace) as RCodeWorkspace;
      await el.updateComplete;

      const sidebar = el.shadowRoot!.querySelector('.doc-sidebar')!;
      expect(sidebar).toBeTruthy();

      const docTitleDiv = sidebar.querySelector('div[style*="text-transform: uppercase"]');
      expect(docTitleDiv).toBeNull();

      const tree = sidebar.querySelector('r-tree') as any;
      expect(tree).toBeTruthy();
      expect(tree.data).toHaveLength(1);
      expect(tree.data[0].id).toBe('collection-documentation');
      expect(tree.data[0].label).toBe('documentation');
      expect(tree.data[0].children).toHaveLength(2);
      expect(tree.data[0].children[0].label).toBe('Overview');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('supports custom collection name property', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (url: string) => {
      if (url === '/guides/toc.json') {
        return {
          ok: true,
          json: async () => [
            { title: 'Guide 1', filename: 'guide-1.html' }
          ]
        } as any;
      }
      return { ok: false } as any;
    }) as any;

    try {
      const el = document.createElement('r-code-workspace') as RCodeWorkspace;
      el.collection = 'guides';
      document.body.appendChild(el);
      await (el as any)._fetchManifest();
      await el.updateComplete;

      const sidebar = el.shadowRoot!.querySelector('.doc-sidebar')!;
      const tree = sidebar.querySelector('r-tree') as any;
      expect(tree).toBeTruthy();
      expect(tree.data).toHaveLength(1);
      expect(tree.data[0].id).toBe('collection-guides');
      expect(tree.data[0].label).toBe('guides');
      expect(tree.data[0].children).toHaveLength(1);
      expect(tree.data[0].children[0].label).toBe('Guide 1');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('collapses and expands documentation sidebar when toggle button is clicked', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () => ({ ok: true, json: async () => [] })) as any;

    try {
      const el = await mountClass(RCodeWorkspace) as RCodeWorkspace;
      await el.updateComplete;

      const sidebar = el.shadowRoot!.querySelector('.doc-sidebar')!;
      expect(sidebar.classList.contains('collapsed')).toBeFalse();

      const toggleBtn = el.shadowRoot!.querySelector('r-button[slot="actions"]') as HTMLElement;
      expect(toggleBtn).toBeTruthy();

      toggleBtn.click();
      await el.updateComplete;
      expect(sidebar.classList.contains('collapsed')).toBeTrue();

      toggleBtn.click();
      await el.updateComplete;
      expect(sidebar.classList.contains('collapsed')).toBeFalse();
    } finally {
      global.fetch = originalFetch;
    }
  });
});
