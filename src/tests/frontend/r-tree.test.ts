import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mountClass, cleanup } from '../helpers/frontend.js';
import { RTree, type TreeNode } from '../../frontend/webkit/r-tree.js';

beforeEach(cleanup);
afterEach(cleanup);

describe('r-tree', () => {
  test('renders empty content when no data provided', async () => {
    const el = await mountClass(RTree) as any;
    el.data = [];
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector('.tree-node')).toBeNull();
  });

  test('renders flat nodes list', async () => {
    const el = await mountClass(RTree) as any;
    el.data = [
      { id: '1', label: 'Node 1' },
      { id: '2', label: 'Node 2' }
    ] as TreeNode[];
    await el.updateComplete;

    const rows = el.shadowRoot!.querySelectorAll('.tree-row');
    expect(rows.length).toBe(2);
    expect(el.shadowRoot!.textContent).toContain('Node 1');
    expect(el.shadowRoot!.textContent).toContain('Node 2');
  });

  test('renders hierarchical nested children', async () => {
    const el = await mountClass(RTree) as any;
    el.data = [
      {
        id: 'p1',
        label: 'Parent',
        children: [
          { id: 'c1', label: 'Child' }
        ]
      }
    ] as TreeNode[];
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector('.tree-children')).toBeTruthy();
    expect(el.shadowRoot!.textContent).toContain('Parent');
    expect(el.shadowRoot!.textContent).toContain('Child');
  });

  test('dispatches node-select when clicking leaf node', async () => {
    const el = await mountClass(RTree) as any;
    const node = { id: 'leaf-node', label: 'Leaf', data: { name: 'leaf' } };
    el.data = [node] as TreeNode[];
    await el.updateComplete;

    let selectedNode: any = null;
    el.addEventListener('node-select', (e: CustomEvent) => {
      selectedNode = e.detail.node;
    });

    const row = el.shadowRoot!.querySelector('.tree-row') as HTMLElement;
    row.click();

    expect(selectedNode).toBeTruthy();
    expect(selectedNode.id).toBe('leaf-node');
    expect(el.selectedId).toBe('leaf-node');
  });

  test('collapse chevron toggle works', async () => {
    const el = await mountClass(RTree) as any;
    const node = {
      id: 'p1',
      label: 'Parent',
      children: [{ id: 'c1', label: 'Child' }]
    };
    el.data = [node] as TreeNode[];
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector('.tree-children')).toBeTruthy();

    const chevron = el.shadowRoot!.querySelector('.tree-chevron') as HTMLElement;
    chevron.click();
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector('.tree-children')).toBeNull();
  });

  test('respects defaultCollapsed property', async () => {
    const el = await mountClass(RTree) as any;
    el.defaultCollapsed = true;
    el.data = [{
      id: 'p1',
      label: 'Parent',
      children: [{ id: 'c1', label: 'Child' }]
    }] as TreeNode[];
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector('.tree-children')).toBeNull();

    const chevron = el.shadowRoot!.querySelector('.tree-chevron') as HTMLElement;
    chevron.click();
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector('.tree-children')).toBeTruthy();
  });
});
