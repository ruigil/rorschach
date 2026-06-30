import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mountClass, cleanup } from '../helpers/frontend.js';
import { RCard } from '../../frontend/webkit/r-card.js';

beforeEach(cleanup);
afterEach(cleanup);

describe('r-card', () => {
  test('renders container and slots', async () => {
    const el = await mountClass(RCard);
    el.innerHTML = '<div slot="header">Header</div>Body<div slot="footer">Footer</div>';
    await el.updateComplete;
    // Wait for the slotchange event handler to update state and trigger another render
    await new Promise(resolve => setTimeout(resolve, 0));
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector('.card-header')).toBeTruthy();
    expect(el.shadowRoot!.querySelector('.card-body')).toBeTruthy();
    expect(el.shadowRoot!.querySelector('.card-footer')).toBeTruthy();
  });

  test('hides footer when no footer content is provided', async () => {
    const el = await mountClass(RCard);
    el.innerHTML = '<div slot="header">Header</div>Body';
    await el.updateComplete;

    const footer = el.shadowRoot!.querySelector('.card-footer') as HTMLElement;
    if (footer) {
      const style = window.getComputedStyle(footer);
      expect(style.display).toBe('none');
    }
  });

  test('shows footer when footer content is provided', async () => {
    const el = await mountClass(RCard);
    el.innerHTML = '<div slot="header">Header</div>Body<div slot="footer">Footer</div>';
    await el.updateComplete;
    // Wait for the slotchange event handler to update state and trigger another render
    await new Promise(resolve => setTimeout(resolve, 0));
    await el.updateComplete;

    const footer = el.shadowRoot!.querySelector('.card-footer') as HTMLElement;
    expect(footer).toBeTruthy();
    const style = window.getComputedStyle(footer);
    expect(style.display).not.toBe('none');
  });

  test('handles hoverable attribute', async () => {
    const el = await mountClass(RCard) as any;
    expect(el.hasAttribute('hoverable')).toBe(false);
    
    el.hoverable = true;
    await el.updateComplete;
    expect(el.hasAttribute('hoverable')).toBe(true);
  });
});
