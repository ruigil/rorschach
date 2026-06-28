import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mountClass, cleanup } from '../helpers/frontend.js';
import { RPanel } from '../../frontend/webkit/r-panel.js';

beforeEach(cleanup);
afterEach(cleanup);

describe('r-panel', () => {
  test('renders panel header and content slots', async () => {
    const el = await mountClass(RPanel);
    el.innerHTML = '<div slot="header">Title</div>Main content';
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector('.panel-header')).toBeTruthy();
    expect(el.shadowRoot!.querySelector('.panel-content')).toBeTruthy();
  });

  test('applies elevation style attributes', async () => {
    const el = await mountClass(RPanel) as any;
    expect(el.getAttribute('elevation')).toBe('1');

    el.elevation = '2';
    await el.updateComplete;
    expect(el.getAttribute('elevation')).toBe('2');
  });
});
