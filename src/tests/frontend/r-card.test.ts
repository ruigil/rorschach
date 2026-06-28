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

    expect(el.shadowRoot!.querySelector('.card-header')).toBeTruthy();
    expect(el.shadowRoot!.querySelector('.card-body')).toBeTruthy();
    expect(el.shadowRoot!.querySelector('.card-footer')).toBeTruthy();
  });

  test('handles hoverable attribute', async () => {
    const el = await mountClass(RCard) as any;
    expect(el.hasAttribute('hoverable')).toBe(false);
    
    el.hoverable = true;
    await el.updateComplete;
    expect(el.hasAttribute('hoverable')).toBe(true);
  });
});
