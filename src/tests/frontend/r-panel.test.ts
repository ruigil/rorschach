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

  test('hides footer when no footer content is provided', async () => {
    const el = await mountClass(RPanel);
    el.innerHTML = '<div slot="header">Title</div>Main content';
    await el.updateComplete;

    const footer = el.shadowRoot!.querySelector('.panel-footer') as HTMLElement;
    if (footer) {
      const style = window.getComputedStyle(footer);
      expect(style.display).toBe('none');
    }
  });

  test('shows footer when footer content is provided', async () => {
    const el = await mountClass(RPanel);
    el.innerHTML = '<div slot="header">Title</div>Main content<div slot="footer">Footer actions</div>';
    await el.updateComplete;
    // Wait for the slotchange event handler to update state and trigger another render
    await new Promise(resolve => setTimeout(resolve, 0));
    await el.updateComplete;

    const footer = el.shadowRoot!.querySelector('.panel-footer') as HTMLElement;
    expect(footer).toBeTruthy();
    const style = window.getComputedStyle(footer);
    expect(style.display).not.toBe('none');
  });
});
