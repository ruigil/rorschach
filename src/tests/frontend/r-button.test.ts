import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mountClass, cleanup } from '../helpers/frontend.js';
import { RButton } from '../../frontend/webkit/r-button.js';

beforeEach(cleanup);
afterEach(cleanup);

describe('r-button', () => {
  test('renders slot content and button tag', async () => {
    const el = await mountClass(RButton);
    el.textContent = 'Click me';
    await el.updateComplete;

    const button = el.shadowRoot!.querySelector('button');
    expect(button).toBeTruthy();
    expect(el.textContent).toBe('Click me');
  });

  test('accepts variant and size properties', async () => {
    const el = await mountClass(RButton) as any;
    el.variant = 'primary';
    el.size = 'sm';
    await el.updateComplete;

    expect(el.getAttribute('variant')).toBe('primary');
    expect(el.getAttribute('size')).toBe('sm');
  });

  test('reflects disabled state', async () => {
    const el = await mountClass(RButton) as any;
    el.disabled = true;
    await el.updateComplete;

    const button = el.shadowRoot!.querySelector('button')!;
    expect(button.disabled).toBe(true);
  });

  test('renders loading spinner when loading is true', async () => {
    const el = await mountClass(RButton) as any;
    el.loading = true;
    await el.updateComplete;

    const spinner = el.shadowRoot!.querySelector('.spinner');
    expect(spinner).toBeTruthy();
  });
});
