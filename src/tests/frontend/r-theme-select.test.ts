import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mountClass, cleanup, mockStore } from '../helpers/frontend.js';
import { RThemeSelect } from '../../frontend/shell/r-theme-select.js';
import { getTheme } from '../../frontend/shell/theme.js';

beforeEach(cleanup);
afterEach(cleanup);

describe('r-theme-select', () => {
  test('renders toggle button with sun icon when dark/eclipse theme is active', async () => {
    mockStore('theme' as any, 'eclipse');
    const el = await mountClass(RThemeSelect) as any;
    await el.updateComplete;

    const btn = el.querySelector('#theme-toggle') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('title')).toBe('Switch to light theme');
    
    const icon = el.querySelector('r-icon') as any;
    expect(icon).toBeTruthy();
    expect(icon.getAttribute('name')).toBe('sun');
  });

  test('renders toggle button with moon icon when light theme is active', async () => {
    mockStore('theme' as any, 'light');
    const el = await mountClass(RThemeSelect) as any;
    await el.updateComplete;

    const btn = el.querySelector('#theme-toggle') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('title')).toBe('Switch to dark theme');
    
    const icon = el.querySelector('r-icon') as any;
    expect(icon).toBeTruthy();
    expect(icon.getAttribute('name')).toBe('moon');
  });

  test('toggles theme when button is clicked', async () => {
    mockStore('theme' as any, 'eclipse');
    const el = await mountClass(RThemeSelect) as any;
    await el.updateComplete;

    const btn = el.querySelector('#theme-toggle') as HTMLButtonElement;
    btn.click();
    
    await el.updateComplete;
    expect(getTheme()).toBe('light');

    btn.click();
    await el.updateComplete;
    expect(getTheme()).toBe('eclipse');
  });
});
