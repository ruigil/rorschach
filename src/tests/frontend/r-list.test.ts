import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mountClass, cleanup } from '../helpers/frontend.js';
import { RList, type ListItem } from '../../frontend/webkit/r-list.js';

beforeEach(cleanup);
afterEach(cleanup);

describe('r-list', () => {
  test('renders empty text when empty', async () => {
    const el = await mountClass(RList) as any;
    el.items = [];
    el.emptyText = 'Empty List Test';
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector('.list-empty')).toBeTruthy();
    expect(el.shadowRoot!.textContent).toContain('Empty List Test');
  });

  test('renders simple items', async () => {
    const el = await mountClass(RList) as any;
    el.items = [
      { id: '1', label: 'Item 1', description: 'Desc 1', meta: 'meta-1' },
      { id: '2', label: 'Item 2' }
    ] as ListItem[];
    await el.updateComplete;

    const items = el.shadowRoot!.querySelectorAll('.list-item');
    expect(items.length).toBe(2);
    expect(el.shadowRoot!.textContent).toContain('Item 1');
    expect(el.shadowRoot!.textContent).toContain('Desc 1');
    expect(el.shadowRoot!.textContent).toContain('meta-1');
  });

  test('does not select item when click if selectable is false', async () => {
    const el = await mountClass(RList) as any;
    el.items = [{ id: '1', label: 'Item 1' }] as ListItem[];
    el.selectable = false;
    await el.updateComplete;

    let selectedId: any = null;
    el.addEventListener('item-select', (e: CustomEvent) => {
      selectedId = e.detail.id;
    });

    const item = el.shadowRoot!.querySelector('.list-item') as HTMLElement;
    item.click();

    expect(selectedId).toBeNull();
    expect(el.selectedId).toBeNull();
  });

  test('selects item when clicked if selectable is true', async () => {
    const el = await mountClass(RList) as any;
    el.items = [{ id: '1', label: 'Item 1' }] as ListItem[];
    el.selectable = true;
    await el.updateComplete;

    let selectedId: any = null;
    el.addEventListener('item-select', (e: CustomEvent) => {
      selectedId = e.detail.id;
    });

    const item = el.shadowRoot!.querySelector('.list-item') as HTMLElement;
    item.click();

    expect(selectedId).toBe('1');
    expect(el.selectedId).toBe('1');
  });

  test('triggers action-click and chip-select events', async () => {
    const el = await mountClass(RList) as any;
    el.items = [{
      id: 'item-1',
      label: 'Item 1',
      chips: [{ id: 'chip-1', label: 'Chip 1' }],
      actions: [{ id: 'act-1', icon: 'wrench', label: 'Action 1' }]
    }] as ListItem[];
    await el.updateComplete;

    let clickedAction: any = null;
    el.addEventListener('action-click', (e: CustomEvent) => {
      clickedAction = e.detail;
    });

    let selectedChip: any = null;
    el.addEventListener('chip-select', (e: CustomEvent) => {
      selectedChip = e.detail;
    });

    const actionBtn = el.shadowRoot!.querySelector('.action-btn') as HTMLElement;
    actionBtn.click();
    expect(clickedAction).toEqual({ itemId: 'item-1', actionId: 'act-1' });

    const chip = el.shadowRoot!.querySelector('.chip') as HTMLElement;
    chip.click();
    expect(selectedChip).toEqual({ itemId: 'item-1', chipId: 'chip-1' });
  });
});
