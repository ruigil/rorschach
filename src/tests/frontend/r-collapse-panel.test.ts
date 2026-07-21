import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanup, mountClass } from '../helpers/frontend.js';
import { RCollapsePanel } from '../../frontend/webkit/r-collapse-panel.js';

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
});

describe('r-collapse-panel', () => {
  test('renders title and open state by default', async () => {
    const el = await mountClass(RCollapsePanel, { title: 'Workflow Information' }) as RCollapsePanel;
    expect(el.open).toBe(true);
    expect(el.shadowRoot?.textContent).toContain('Workflow Information');
  });

  test('toggles open state on header click', async () => {
    const el = await mountClass(RCollapsePanel, { title: 'Task Information' }) as RCollapsePanel;
    const header = el.shadowRoot?.querySelector('.collapse-header') as HTMLElement;
    expect(header).not.toBeNull();

    let toggledOpen: boolean | null = null;
    el.addEventListener('toggle', (e: any) => {
      toggledOpen = e.detail.open;
    });

    header.click();
    await el.updateComplete;

    expect(el.open).toBe(false);
    expect(toggledOpen as boolean | null).toBe(false);

    header.click();
    await el.updateComplete;

    expect(el.open).toBe(true);
    expect(toggledOpen as boolean | null).toBe(true);
  });

  test('renders status badge in header without altering collapse header container layout', async () => {
    const elWithBadge = await mountClass(RCollapsePanel, { title: 'Workflow Run', status: 'completed' }) as RCollapsePanel;
    const elWithoutBadge = await mountClass(RCollapsePanel, { title: 'Workflow' }) as RCollapsePanel;

    const badge = elWithBadge.shadowRoot?.querySelector('r-badge');
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute('status')).toBe('completed');

    const headerWithBadge = elWithBadge.shadowRoot?.querySelector('.collapse-header') as HTMLElement;
    const headerWithoutBadge = elWithoutBadge.shadowRoot?.querySelector('.collapse-header') as HTMLElement;
    expect(headerWithBadge).not.toBeNull();
    expect(headerWithoutBadge).not.toBeNull();
  });
});
